import { useState } from 'react';
import {
  listRescheduleRequests,
  resolveBookingRescheduleRequest,
  type RescheduleRequestDto,
} from '../api/rescheduleRequests';
import {
  listCancelRequests,
  resolveBookingCancellationRequest,
  type CancelRequestDto,
} from '../api/cancelRequests';
import {
  listPendingBookingRequests,
  approveBookingRequest,
  declineBookingRequest,
  type PendingBookingRequestDto,
} from '../api/bookingRequests';
import { bookingWhenLabel } from '../lib/bookingDetailFormat';
import { useOneShot } from '../lib/useOneShot';
import { useToast } from './Toast';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import './VisitRequestsSection.css';

/**
 * Incoming visit requests from households: the reschedule ask (#399 item 2)
 * and the cancellation ask (#438), in ONE queue.
 *
 * Both are the same job for an operator -- a household asked for something and
 * is waiting on an answer -- so they are one section rather than two stacked
 * banners competing for the same corner of the Bookings screen. The
 * cancellation half is the older of the two and was the worse gap: the flag has
 * been written to the visit since 2026-07-02 and, until #438, no admin screen
 * anywhere read it, while the portal told the household their request had been
 * sent.
 *
 * Self-contained and modelled on `NeedsTriageSection`: it fetches its own queue
 * through callables rather than a live listener, because the requests live in
 * the per-household `kinCares` subcollection and `useCollection` cannot express
 * a collection-group query. A resolved row is removed locally the moment the
 * server confirms the write, never re-fetched and never assumed.
 *
 * #698: the block reserves its own space from the first paint rather than
 * rendering nothing while the three callables are in flight. A cold start on
 * any one of them was taking up to ten seconds, so a silent load popped the
 * block in late and shoved the stat strip and the Bookings list down after
 * the screen had already settled. The loading panel is shape only, no counts
 * claimed, and a proven-empty result says so plainly instead of vanishing, so
 * the section that sits above the list never shifts once the read lands. A
 * FAILED read is still never silent: an operator who believes nothing is
 * waiting, when really the read never landed, leaves a household waiting on
 * an answer that is never coming. The three queues are read independently and
 * reported independently, so one broken read cannot hide the other queues'
 * rows.
 */

/** One row, whichever kind of ask it is. */
export type VisitRequest =
  | { kind: 'reschedule'; request: RescheduleRequestDto }
  | { kind: 'cancel'; request: CancelRequestDto }
  | { kind: 'newBooking'; request: PendingBookingRequestDto };

interface QueueLoad {
  requests: VisitRequest[];
  /** Human-readable reason per queue that failed. Empty when both landed. */
  failures: string[];
}

/** `1756738800000` -> "Tue, Sep 1 at 3:00 PM". "Not set" when the request carries no time. */
export function whenLabel(ms: number | null): string {
  if (ms === null) return 'Not set';
  return bookingWhenLabel(new Date(ms).toISOString());
}

/**
 * The row's stable identity: a visit id is only unique inside its household, and
 * two asks can sit on one visit.
 *
 * A `newBooking` row has NO visit id. It is a whole envelope, answered as one
 * (#532/#533), so its identity ends at the batch.
 */
export function requestKey(row: VisitRequest): string {
  if (row.kind === 'newBooking') {
    return `newBooking/${row.request.kinfolkId}/${row.request.batchId}`;
  }
  return `${row.kind}/${row.request.kinfolkId}/${row.request.batchId}/${row.request.visitId}`;
}

/** Oldest first: the household that has been waiting longest is the one to answer. */
export function mergeQueues(
  reschedule: RescheduleRequestDto[],
  cancel: CancelRequestDto[],
  newBookings: PendingBookingRequestDto[] = [],
): VisitRequest[] {
  const rows: VisitRequest[] = [
    ...reschedule.map((request): VisitRequest => ({ kind: 'reschedule', request })),
    ...cancel.map((request): VisitRequest => ({ kind: 'cancel', request })),
    ...newBookings.map((request): VisitRequest => ({ kind: 'newBooking', request })),
  ];
  // A row with no `requestedAtMs` sorts last rather than to 1970: an unknown
  // wait is not a long one, and putting it at the top would push a household
  // that really has been waiting since July down the list.
  return rows.sort(
    (a, b) =>
      (a.request.requestedAtMs ?? Number.MAX_SAFE_INTEGER) -
      (b.request.requestedAtMs ?? Number.MAX_SAFE_INTEGER),
  );
}

async function loadQueues(): Promise<QueueLoad> {
  // Three independent reads, reported independently: one broken queue must not
  // hide the other two, and a queue that failed must never read as empty.
  const [resched, cancel, newBookings] = await Promise.allSettled([
    listRescheduleRequests(),
    listCancelRequests(),
    listPendingBookingRequests(),
  ]);
  const failures: string[] = [];
  if (resched.status === 'rejected') {
    failures.push(`Reschedule requests: ${reasonOf(resched.reason)}`);
  }
  if (cancel.status === 'rejected') {
    failures.push(`Cancellation requests: ${reasonOf(cancel.reason)}`);
  }
  if (newBookings.status === 'rejected') {
    failures.push(`New booking requests: ${reasonOf(newBookings.reason)}`);
  }
  return {
    requests: mergeQueues(
      resched.status === 'fulfilled' ? resched.value.requests : [],
      cancel.status === 'fulfilled' ? cancel.value.requests : [],
      newBookings.status === 'fulfilled' ? newBookings.value.requests : [],
    ),
    failures,
  };
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : 'the read did not land';
}

export function VisitRequestsSection() {
  const loaded = useOneShot(loadQueues, 'visit requests');
  const [resolvedKeys, setResolvedKeys] = useState<ReadonlySet<string>>(new Set());
  const [activeSheet, setActiveSheet] = useState<
    { row: VisitRequest; decision: 'accept' | 'decline' } | null
  >(null);
  const { showToast } = useToast();

  if (loaded.status === 'loading') {
    return (
      <section className="visit-requests" role="status" aria-live="polite">
        <div className="visit-requests__skeleton-panel">
          <p className="visit-requests__skeleton-label">Checking for requests…</p>
          <span className="visit-requests__skeleton-bar visit-requests__skeleton-bar--title" />
          <span className="visit-requests__skeleton-bar" />
        </div>
      </section>
    );
  }
  if (loaded.status === 'error') {
    return (
      <Banner
        tone="error"
        title="Couldn't load visit requests"
        trailing={loaded.retry && <GhostButton label="Retry" onClick={loaded.retry} />}
      >
        {loaded.message}
      </Banner>
    );
  }

  const rows = loaded.data.requests.filter((r) => !resolvedKeys.has(requestKey(r)));
  const { failures } = loaded.data;
  if (rows.length === 0 && failures.length === 0) {
    return (
      <section className="visit-requests">
        <p className="visit-requests__empty">No visit requests waiting.</p>
      </section>
    );
  }

  function onResolved(row: VisitRequest, message: string) {
    setResolvedKeys((prev) => new Set(prev).add(requestKey(row)));
    setActiveSheet(null);
    showToast(message);
  }

  return (
    <section className="visit-requests">
      {failures.length > 0 && (
        <Banner tone="error" title="One of these queues didn't load">
          {`${failures.join(' ')} Anything waiting there is not on this list.`}
        </Banner>
      )}

      {rows.length > 0 && (
        <>
          <Banner tone="warning" title="Visit requests" pillLabel={`${String(rows.length)} waiting`}>
            Households asked for these changes and are waiting on an answer. Accepting a reschedule moves
            the visit on both the schedule and their portal; accepting a cancellation takes it off both.
            Declining leaves the visit alone and lets them know your answer.
          </Banner>

          <ul className="visit-requests__list">
            {rows.map((row) => (
              <li key={requestKey(row)} className="visit-requests__row">
                <div className="visit-requests__row-meta">
                  <span className="visit-requests__row-kind" data-kind={row.kind}>
                    {rowKindLabel(row.kind)}
                  </span>
                  <span className="visit-requests__row-title">{rowTitle(row)}</span>
                  {row.request.kinNames.length > 0 && (
                    <>
                      <span className="visit-requests__row-dot" aria-hidden="true">
                        ·
                      </span>
                      <span>{row.request.kinNames.join(', ')}</span>
                    </>
                  )}
                </div>
                <p className="visit-requests__row-when">{rowWhen(row)}</p>
                {reasonOfRow(row) !== null && (
                  <p className="visit-requests__row-reason">{reasonOfRow(row)}</p>
                )}
                <div className="visit-requests__row-actions">
                  <PrimaryButton
                    label="Accept"
                    onClick={() => setActiveSheet({ row, decision: 'accept' })}
                  />
                  <GhostButton
                    label="Decline"
                    onClick={() => setActiveSheet({ row, decision: 'decline' })}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {activeSheet && (
        <DecisionDialog
          row={activeSheet.row}
          decision={activeSheet.decision}
          onClose={() => setActiveSheet(null)}
          onResolved={onResolved}
        />
      )}
    </section>
  );
}

/**
 * A reschedule row shows both windows; a cancellation row shows the visit it
 * would take off the books; a new request shows the span it covers.
 *
 * A multi-visit request reads as a count and a range rather than a list of
 * dates, matching the wording the household's own confirmation uses (#532), so
 * the operator and the household are looking at the same phrase.
 */
export function rowWhen(row: VisitRequest): string {
  if (row.kind === 'newBooking') {
    const { visitCount, firstStartTimeMs, lastStartTimeMs } = row.request;
    if (visitCount <= 1) return whenLabel(firstStartTimeMs);
    return `${String(visitCount)} visits, ${whenLabel(firstStartTimeMs)} to ${whenLabel(lastStartTimeMs)}`;
  }
  if (row.kind === 'cancel') return whenLabel(row.request.startTimeMs);
  return `${whenLabel(row.request.currentStartTimeMs)} → ${whenLabel(row.request.proposedStartTimeMs)}`;
}

function reasonOfRow(row: VisitRequest): string | null {
  // A new request has no "reason" field. What it has is the household's own
  // notes for the whole request, which is the thing an operator needs to read
  // before answering it.
  if (row.kind === 'newBooking') return row.request.notes;
  return row.request.reason;
}

/** What the row calls itself in the queue. */
function rowKindLabel(kind: VisitRequest['kind']): string {
  if (kind === 'newBooking') return 'New request';
  return kind === 'cancel' ? 'Cancel' : 'Reschedule';
}

/** A new request has no `title`; it is named by its service and household. */
function rowTitle(row: VisitRequest): string {
  if (row.kind === 'newBooking') {
    return row.request.serviceType ?? row.request.kinfolkName ?? 'Care request';
  }
  return row.request.title ?? row.request.serviceType ?? 'Visit';
}

interface DecisionDialogProps {
  row: VisitRequest;
  decision: 'accept' | 'decline';
  onClose: () => void;
  onResolved: (row: VisitRequest, message: string) => void;
}

/**
 * Confirm copy is written in the future tense and the confirm button never
 * repeats the trigger's label, per the convention `screens/BookingActions.tsx`
 * sets for every other booking decision in this app.
 */
function DecisionDialog({ row, decision, onClose, onResolved }: DecisionDialogProps) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const declining = decision === 'decline';
  const cancelling = row.kind === 'cancel';
  const isNewRequest = row.kind === 'newBooking';
  const { kinfolkId, batchId } = row.request;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const message = isNewRequest
        ? await submitNewRequest(kinfolkId, batchId, decision, note)
        : cancelling
          ? await submitCancel(kinfolkId, batchId, row.request.visitId, decision, note)
          : await submitReschedule(kinfolkId, batchId, row.request.visitId, decision, note);
      setBusy(false);
      onResolved(row, message);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'That did not go through. Try again.');
    }
  }

  return (
    <Dialog
      title={dialogTitle(row.kind, decision)}
      onClose={onClose}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={busy} />
          <PrimaryButton
            label={busy ? 'Working…' : confirmLabel(row.kind, decision)}
            onClick={() => void submit()}
            disabled={busy}
          />
        </>
      }
    >
      <p className="visit-requests__dialog-line">{dialogLine(row, decision)}</p>
      <label className="visit-requests__dialog-label" htmlFor="visit-request-note">
        {declining ? 'Anything to add for the household (optional)' : 'Note for the household (optional)'}
      </label>
      <textarea
        id="visit-request-note"
        className="visit-requests__dialog-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
      />
      {error !== null && (
        <Banner tone="error" title="Not done">
          {error}
        </Banner>
      )}
    </Dialog>
  );
}

/**
 * Approves or declines a whole booking request (#533).
 *
 * Both actions go through `manageBookingSeries`, which rules on the ENVELOPE in
 * one transaction, so a four-day request is answered once rather than four
 * times. Approving creates the `kin_care_sessions` rows, which is what makes the
 * visits appear on the Bookings list and the schedule; declining books nothing
 * and tells the household once, with the operator's optional note if they left
 * one (#700: the office does not owe a reason).
 *
 * #536: THE COPY REPORTS THE SERVER'S ANSWER RATHER THAN ASSUMING IT. Every
 * clean approve used to end with "the household has been told", which
 * undercounted: one approval sent one message PER VISIT, so a four-day request
 * told them four times. It really is once now, and the same sentence has to stop
 * claiming it in the three cases where nothing went out at all -- a partial
 * failure (the request stays retryable and the household is still waiting), a
 * re-approve of something already booked, and a dispatch that did not land.
 * `householdNotified` and `newlyConfirmed` are what the server actually did.
 */
async function submitNewRequest(
  kinfolkId: string,
  batchId: string,
  decision: 'accept' | 'decline',
  note: string,
): Promise<string> {
  if (decision === 'decline') {
    // READ what the server did rather than asserting it, the way the approve
    // branch below already does. `manageBookingSeries` has returned
    // `householdNotified` on the CANCEL path since #536, and Android has read it
    // since (`EnhancedSchedulingViewModel.householdLine`, its `action ==
    // "CANCEL"` arm). This client was the one still promising the household
    // "gets your reason" on the back of a dispatch that may have thrown. A
    // request turned down in silence is what #533 exists to end, and an operator
    // who is not told about the silence cannot phone them instead.
    const declined = await declineBookingRequest(kinfolkId, batchId, note);
    return declined.householdNotified
      ? 'Declined. Nothing was booked and the household has your answer.'
      : 'Declined. Nothing was booked, but the message to the household did not go out, so tell them another way.';
  }
  const res = await approveBookingRequest(kinfolkId, batchId);
  if (res.failedVisits > 0) {
    return `Approved ${String(res.affectedVisits)} of ${String(res.affectedVisits + res.failedVisits)} visits. The rest did not go through and the household has not been told, so try again.`;
  }
  if (res.newlyConfirmed === 0) {
    return 'This was already booked. Nothing changed and the household was not told again.';
  }
  const visits =
    res.affectedVisits === 1 ? 'The visit is' : `All ${String(res.affectedVisits)} visits are`;
  return res.householdNotified
    ? `Approved. ${visits} on the schedule and the household has been told once, with every date.`
    : `Approved. ${visits} on the schedule, but the message to the household did not go out, so tell them another way.`;
}

async function submitReschedule(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  decision: 'accept' | 'decline',
  note: string,
): Promise<string> {
  const res = await resolveBookingRescheduleRequest(kinfolkId, batchId, visitId, decision, note);
  if (decision === 'decline') return 'Declined. The household will see your answer on their booking.';
  return res.sessionUpdated
    ? 'Moved. The schedule and the household now show the new time.'
    : 'Moved. This visit is still a request, so it has no schedule row to move yet.';
}

async function submitCancel(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  decision: 'accept' | 'decline',
  note: string,
): Promise<string> {
  const res = await resolveBookingCancellationRequest(kinfolkId, batchId, visitId, decision, note);
  if (decision === 'decline') {
    return 'Declined. The visit stays on the schedule and the household gets your answer.';
  }
  return res.sessionUpdated
    ? 'Cancelled. It is off the schedule and off the household’s portal.'
    : 'Cancelled. This visit was still a request, so it had no schedule row to take off.';
}

function dialogTitle(kind: VisitRequest['kind'], decision: 'accept' | 'decline'): string {
  if (kind === 'newBooking') {
    return decision === 'decline' ? 'Turn down this request' : 'Book this request';
  }
  if (kind === 'cancel') {
    return decision === 'decline' ? 'Keep this visit' : 'Cancel this visit';
  }
  return decision === 'decline' ? 'Decline this new time' : 'Move this visit';
}

function confirmLabel(kind: VisitRequest['kind'], decision: 'accept' | 'decline'): string {
  if (decision === 'decline') return 'Send the decline';
  if (kind === 'newBooking') return 'Book it';
  return kind === 'cancel' ? 'Cancel it' : 'Move it';
}

function dialogLine(row: VisitRequest, decision: 'accept' | 'decline'): string {
  if (row.kind === 'newBooking') {
    const when = rowWhen(row);
    return decision === 'decline'
      ? `${when} will not be booked. The household will be told.`
      : `${when} will go on the schedule and on the household's portal.`;
  }
  if (row.kind === 'cancel') {
    const when = whenLabel(row.request.startTimeMs);
    return decision === 'decline'
      ? `${when} stays on the schedule. The household will be told it is going ahead.`
      : `${when} will be taken off the schedule and off the household's portal.`;
  }
  const current = whenLabel(row.request.currentStartTimeMs);
  const proposed = whenLabel(row.request.proposedStartTimeMs);
  return decision === 'decline'
    ? `${proposed} will not be booked. The visit stays at ${current}.`
    : `This visit will move from ${current} to ${proposed}.`;
}
