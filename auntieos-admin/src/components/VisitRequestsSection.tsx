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
 * Silent while loading and silent when empty, because most days there is
 * nothing waiting and a section that may turn out empty should not flash a
 * skeleton above the Bookings list. A FAILED read is the one state that is
 * never silent: an operator who believes nothing is waiting, when really the
 * read never landed, leaves a household waiting on an answer that is never
 * coming. The two queues are read independently and reported independently, so
 * one broken read cannot hide the other queue's rows.
 */

/** One row, whichever kind of ask it is. */
export type VisitRequest =
  | { kind: 'reschedule'; request: RescheduleRequestDto }
  | { kind: 'cancel'; request: CancelRequestDto };

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

/** The row's stable identity: a visit id is only unique inside its household, and two asks can sit on one visit. */
export function requestKey(row: VisitRequest): string {
  const r = row.request;
  return `${row.kind}/${r.kinfolkId}/${r.batchId}/${r.visitId}`;
}

/** Oldest first: the household that has been waiting longest is the one to answer. */
export function mergeQueues(
  reschedule: RescheduleRequestDto[],
  cancel: CancelRequestDto[],
): VisitRequest[] {
  const rows: VisitRequest[] = [
    ...reschedule.map((request): VisitRequest => ({ kind: 'reschedule', request })),
    ...cancel.map((request): VisitRequest => ({ kind: 'cancel', request })),
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
  const [resched, cancel] = await Promise.allSettled([listRescheduleRequests(), listCancelRequests()]);
  const failures: string[] = [];
  if (resched.status === 'rejected') {
    failures.push(`Reschedule requests: ${reasonOf(resched.reason)}`);
  }
  if (cancel.status === 'rejected') {
    failures.push(`Cancellation requests: ${reasonOf(cancel.reason)}`);
  }
  return {
    requests: mergeQueues(
      resched.status === 'fulfilled' ? resched.value.requests : [],
      cancel.status === 'fulfilled' ? cancel.value.requests : [],
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

  if (loaded.status === 'loading') return null;
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
  if (rows.length === 0 && failures.length === 0) return null;

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
            Declining leaves the visit alone and sends them your reason.
          </Banner>

          <ul className="visit-requests__list">
            {rows.map((row) => (
              <li key={requestKey(row)} className="visit-requests__row">
                <div className="visit-requests__row-meta">
                  <span className="visit-requests__row-kind" data-kind={row.kind}>
                    {row.kind === 'cancel' ? 'Cancel' : 'Reschedule'}
                  </span>
                  <span className="visit-requests__row-title">
                    {row.request.title ?? row.request.serviceType ?? 'Visit'}
                  </span>
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

/** A reschedule row shows both windows; a cancellation row shows the visit it would take off the books. */
function rowWhen(row: VisitRequest): string {
  if (row.kind === 'cancel') return whenLabel(row.request.startTimeMs);
  return `${whenLabel(row.request.currentStartTimeMs)} → ${whenLabel(row.request.proposedStartTimeMs)}`;
}

function reasonOfRow(row: VisitRequest): string | null {
  return row.request.reason;
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
  const noteMissing = declining && note.trim().length === 0;
  const { kinfolkId, batchId, visitId } = row.request;

  async function submit() {
    if (noteMissing) {
      setError(
        cancelling
          ? 'Say why the visit is staying. The household sees this on their booking.'
          : 'Say why the time does not work. The household sees this on their booking.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const message = cancelling
        ? await submitCancel(kinfolkId, batchId, visitId, decision, note)
        : await submitReschedule(kinfolkId, batchId, visitId, decision, note);
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
        {declining ? declineNoteLabel(row.kind) : 'Note for the household (optional)'}
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

async function submitReschedule(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  decision: 'accept' | 'decline',
  note: string,
): Promise<string> {
  const res = await resolveBookingRescheduleRequest(kinfolkId, batchId, visitId, decision, note);
  if (decision === 'decline') return 'Declined. The household will see your reason on their booking.';
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
    return 'Declined. The visit stays on the schedule and the household gets your reason.';
  }
  return res.sessionUpdated
    ? 'Cancelled. It is off the schedule and off the household’s portal.'
    : 'Cancelled. This visit was still a request, so it had no schedule row to take off.';
}

function dialogTitle(kind: VisitRequest['kind'], decision: 'accept' | 'decline'): string {
  if (kind === 'cancel') {
    return decision === 'decline' ? 'Keep this visit' : 'Cancel this visit';
  }
  return decision === 'decline' ? 'Decline this new time' : 'Move this visit';
}

function confirmLabel(kind: VisitRequest['kind'], decision: 'accept' | 'decline'): string {
  if (decision === 'decline') return 'Send the decline';
  return kind === 'cancel' ? 'Cancel it' : 'Move it';
}

function declineNoteLabel(kind: VisitRequest['kind']): string {
  return kind === 'cancel' ? 'Why it is staying' : 'Why it does not work';
}

function dialogLine(row: VisitRequest, decision: 'accept' | 'decline'): string {
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
