import { useEffect, useState } from 'react';
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
  type ApproveOptions,
  type PendingBookingRequestDto,
} from '../api/bookingRequests';
import { getBusinessSettings } from '../api/settings';
import type { ListPendingBookingRequestsResultRequestVisit } from '../contracts/bookingContracts.generated';
import { bookingWhenLabel } from '../lib/bookingDetailFormat';
import { BOOKING_BUSY_CONFLICT_CODE, callableConflictCode } from '../lib/bookingWizard';
import { nightLabel, startTimeOnNight } from '../lib/businessZoneTime';
import { DEFAULT_BUSINESS_TIME_ZONE, resolveBusinessTimeZone } from '../lib/businessOperations';
import { useOneShot } from '../lib/useOneShot';
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
  /** #1577: the request whose card body was pressed, open in its detail sheet. */
  const [detailRow, setDetailRow] = useState<VisitRequest | null>(null);
  /**
   * #704: the queue reads as ONE compact banner until asked to open.
   *
   * The mock goes from the page heading straight into Pending approval /
   * Scheduled / History. This block sits above them because it is work waiting
   * on a human, but drawn open it was three request cards tall and pushed the
   * first section to y=580 on a screen where the queue is usually empty. The
   * banner still states the count out loud, so nothing is hidden: "Review 3"
   * is one press away and the rows are unchanged underneath it.
   */
  const [open, setOpen] = useState(false);
  /**
   * #1577: what the last answer did, and for whom, kept on the screen until the
   * operator dismisses it. It used to be a toast, and that was not enough: the QA walk pressed
   * Accept, watched "Working…" for 4 seconds, saw the sheet close and read no
   * result, because a 5-second toast is easy to miss while the list re-renders
   * and the answered card leaves it.
   */
  const [outcome, setOutcome] = useState<string | null>(null);
  const outcomeBanner =
    outcome === null ? null : (
      <Banner
        tone="success"
        title="Done"
        trailing={<GhostButton label="Dismiss" onClick={() => setOutcome(null)} />}
      >
        <span role="status">{outcome}</span>
      </Banner>
    );

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
  function onResolved(row: VisitRequest, message: string) {
    // #1577: the answer names who it was for, and stays on the screen.
    const said = `${householdLabel(row)}: ${message}`;
    setResolvedKeys((prev) => new Set(prev).add(requestKey(row)));
    setActiveSheet(null);
    setOutcome(said);
  }

  if (rows.length === 0 && failures.length === 0) {
    return (
      <section className="visit-requests">
        {outcomeBanner}
        <p className="visit-requests__empty">No visit requests waiting.</p>
      </section>
    );
  }

  return (
    <section className="visit-requests">
      {outcomeBanner}
      {failures.length > 0 && (
        <Banner tone="error" title="One of these queues didn't load">
          {`${failures.join(' ')} Anything waiting there is not on this list.`}
        </Banner>
      )}

      {rows.length > 0 && (
        <>
          <Banner
            tone="warning"
            title="Visit requests"
            pillLabel={`${String(rows.length)} waiting`}
            trailing={
              <GhostButton
                label={open ? 'Hide' : `Review ${String(rows.length)}`}
                pressed={open}
                onClick={() => setOpen((o) => !o)}
              />
            }
          >
            Households asked to move, cancel, or book a visit and are waiting on an answer.
          </Banner>

          {open && (
          <ul className="visit-requests__list">
            {rows.map((row) => (
              <li key={requestKey(row)} className="visit-requests__row">
                {/* #1577: the card body opens the request. A button, so it is
                    reachable from the keyboard and reads as one control. */}
                <button
                  type="button"
                  className="visit-requests__row-open"
                  onClick={() => setDetailRow(row)}
                >
                  <span className="visit-requests__row-meta">
                    <span className="visit-requests__row-kind" data-kind={row.kind}>
                      {rowKindLabel(row.kind)}
                    </span>
                    <span className="visit-requests__row-title">{householdLabel(row)}</span>
                  </span>
                  <span className="visit-requests__row-subject">{rowSubject(row)}</span>
                  <span className="visit-requests__row-when">{rowWhen(row)}</span>
                  {reasonOfRow(row) !== null && (
                    <span className="visit-requests__row-reason">{reasonOfRow(row)}</span>
                  )}
                </button>
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
          )}
        </>
      )}

      {detailRow && (
        <RequestDetailDialog
          row={detailRow}
          onClose={() => setDetailRow(null)}
          onDecide={(decision) => {
            setDetailRow(null);
            setActiveSheet({ row: detailRow, decision });
          }}
        />
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
export function rowWhen(row: VisitRequest, nightsAwaitTime = true): string {
  if (row.kind === 'newBooking') {
    const { visitCount, firstStartTimeMs, lastStartTimeMs } = row.request;
    // #1098: a night awaiting its start time has no instant, and the first and
    // last times leave it out, so it is named by its date on its own.
    const waiting = pendingVisits(row.request);
    const nights = nightsLabel(waiting, nightsAwaitTime);
    const timedCount = visitCount - waiting.length;
    if (nights !== null && timedCount <= 0) return nights;
    const timed =
      timedCount <= 1
        ? whenLabel(firstStartTimeMs)
        : `${String(timedCount)} visits, ${whenLabel(firstStartTimeMs)} to ${whenLabel(lastStartTimeMs)}`;
    return nights === null ? timed : `${timed}. ${nights}`;
  }
  if (row.kind === 'cancel') return whenLabel(row.request.startTimeMs);
  return `${whenLabel(row.request.currentStartTimeMs)} → ${whenLabel(row.request.proposedStartTimeMs)}`;
}

/**
 * #1098: the visits of a request still waiting for the operator to set their
 * start time. `visits` is absent on a payload from a server older than #1098,
 * so it is read defensively.
 */
export function pendingVisits(
  request: PendingBookingRequestDto,
): ListPendingBookingRequestsResultRequestVisit[] {
  return (request.visits ?? []).filter((v) => v.startTimePending);
}

/**
 * "Night of Fri, Oct 9, start time not set", or null when no night is waiting.
 * The dates are joined with "and" because each one already has a comma in it.
 * The dialog where the time is being set drops the "not set" part.
 */
function nightsLabel(
  visits: ListPendingBookingRequestsResultRequestVisit[],
  awaitingTime: boolean,
): string | null {
  if (visits.length === 0) return null;
  const dates = visits.map((v) => (v.requestedDate ? nightLabel(v.requestedDate) : 'a night'));
  if (visits.length === 1) {
    return awaitingTime ? `Night of ${dates[0]!}, start time not set` : `The night of ${dates[0]!}`;
  }
  const list = `${dates.slice(0, -1).join(', ')} and ${dates[dates.length - 1]!}`;
  return awaitingTime ? `Nights of ${list}, start times not set` : `The nights of ${list}`;
}

/** What the time field calls one night: its KinCare and its date. */
function nightFieldName(
  visit: ListPendingBookingRequestsResultRequestVisit,
  request: PendingBookingRequestDto,
): string {
  const kinCare = visit.serviceType ?? request.serviceType ?? 'KinCare';
  return visit.requestedDate ? `${kinCare} on ${nightLabel(visit.requestedDate)}` : kinCare;
}

/**
 * The `details.code` of the visit-overlap refusal. Mirrors
 * `VISIT_OVERLAP_CONFLICT_CODE` in `api/scheduleWrite.ts`, kept here so this
 * component does not pull another callables module in for one string.
 */
const VISIT_OVERLAP_CODE = 'visit_overlap_conflict';

/**
 * Which override this refusal can be retried with, or null. A busy block and a
 * visit already on the books are overridable (the same two `rescheduleBooking`
 * offers); a closed day, a missing time and a time off the night are not. A
 * kind already overridden is never offered twice.
 */
function overridableApproveRefusal(err: unknown, granted: ApproveOptions): 'busy' | 'visit' | null {
  const code = callableConflictCode(err);
  if (code === BOOKING_BUSY_CONFLICT_CODE && granted.overrideBusyConflict !== true) return 'busy';
  if (code === VISIT_OVERLAP_CODE && granted.overrideVisitConflict !== true) return 'visit';
  return null;
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

/**
 * #1577: WHO is asking, the first thing an operator needs before answering.
 * All three queues carry `kinfolkName` (the household's `displayName`), null
 * only when the household record would not read.
 */
export function householdLabel(row: VisitRequest): string {
  const name = row.request.kinfolkName?.trim() ?? '';
  return name === '' ? 'Household name not on file' : name;
}
/** What the request is about: the service, then the Kin it covers. */
export function rowSubject(row: VisitRequest): string {
  const service =
    row.kind === 'newBooking'
      ? (row.request.serviceType ?? 'Care request')
      : (row.request.title ?? row.request.serviceType ?? 'Visit');
  const kin = row.request.kinNames.filter((n) => n.trim() !== '').join(', ');
  return kin === '' ? service : `${service} · ${kin}`;
}
/** " for The Wrens", or nothing when the household name did not read. */
function forHousehold(row: VisitRequest, preposition: 'for' | 'from'): string {
  const name = row.request.kinfolkName?.trim() ?? '';
  return name === '' ? '' : ` ${preposition} ${name}`;
}
/** "30 min", "1 hr 30 min". Null when the length is not known. */
function lengthLabel(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${String(m)} min`;
  return m === 0 ? `${String(h)} hr` : `${String(h)} hr ${String(m)} min`;
}
/**
 * One line per visit a request covers, so the detail sheet lists the days
 * rather than a span. A night awaiting its start time (#1098) is named by its
 * date. `visits` is absent on a payload from a server older than #1098, so
 * the start list stands in for it.
 */
export function requestVisitLines(request: PendingBookingRequestDto): string[] {
  const visits = request.visits ?? [];
  if (visits.length === 0) return request.startTimeMsList.map((ms) => whenLabel(ms));
  return visits.map((v) => {
    const when =
      v.startTimeMs !== null
        ? whenLabel(v.startTimeMs)
        : `Night of ${v.requestedDate ? nightLabel(v.requestedDate) : 'a date not on file'}, start time not set`;
    const parts = [when, v.serviceType, v.timeBlockLabel, lengthLabel(v.lengthMinutes)].filter(
      (p): p is string => p !== null && p !== undefined && p !== '',
    );
    return parts.join(' · ');
  });
}
interface RequestDetailDialogProps {
  row: VisitRequest;
  onClose: () => void;
  onDecide: (decision: 'accept' | 'decline') => void;
}
/**
 * #1577: the request opened from its card. Everything the office needs to
 * answer it, household first, with the same Accept and Decline the card
 * carries. Answering still goes through `DecisionDialog`, so the confirm step
 * and its copy are one path whichever way the operator got there.
 */
function RequestDetailDialog({ row, onClose, onDecide }: RequestDetailDialogProps) {
  const reason = reasonOfRow(row);
  const kin = row.request.kinNames.filter((n) => n.trim() !== '');
  return (
    <Dialog
      title={`${rowKindLabel(row.kind)}${forHousehold(row, 'from')}`}
      onClose={onClose}
      footer={
        <>
          <GhostButton label="Close" onClick={onClose} />
          <GhostButton label="Decline" onClick={() => onDecide('decline')} />
          <PrimaryButton label="Accept" onClick={() => onDecide('accept')} />
        </>
      }
    >
      <dl className="visit-requests__facts">
        <div className="visit-requests__fact">
          <dt>Household</dt>
          <dd>{householdLabel(row)}</dd>
        </div>
        <div className="visit-requests__fact">
          <dt>Service</dt>
          <dd>
            {row.kind === 'newBooking'
              ? (row.request.serviceType ?? 'Not on the request')
              : (row.request.title ?? row.request.serviceType ?? 'Not on the visit')}
          </dd>
        </div>
        <div className="visit-requests__fact">
          <dt>Kin</dt>
          <dd>{kin.length > 0 ? kin.join(', ') : 'Not on the request'}</dd>
        </div>
        {row.kind === 'newBooking' ? (
          <div className="visit-requests__fact">
            <dt>{row.request.visitCount === 1 ? 'Visit' : `${String(row.request.visitCount)} visits`}</dt>
            <dd>
              <ul className="visit-requests__fact-list">
                {requestVisitLines(row.request).map((line, i) => (
                  <li key={`${String(i)}-${line}`}>{line}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : row.kind === 'cancel' ? (
          <div className="visit-requests__fact">
            <dt>Visit</dt>
            <dd>{whenLabel(row.request.startTimeMs)}</dd>
          </div>
        ) : (
          <>
            <div className="visit-requests__fact">
              <dt>Booked for</dt>
              <dd>{whenLabel(row.request.currentStartTimeMs)}</dd>
            </div>
            <div className="visit-requests__fact">
              <dt>Asked to move to</dt>
              <dd>{whenLabel(row.request.proposedStartTimeMs)}</dd>
            </div>
          </>
        )}
        <div className="visit-requests__fact">
          <dt>{row.kind === 'newBooking' ? 'Notes on the request' : 'Reason given'}</dt>
          <dd>{reason ?? 'None given'}</dd>
        </div>
        <div className="visit-requests__fact">
          <dt>Asked</dt>
          <dd>{whenLabel(row.request.requestedAtMs)}</dd>
        </div>
      </dl>
    </Dialog>
  );
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
  // #1100: accepting a reschedule is guarded like a move, so a clash on the new
  // time is overridable here exactly as it is on an Overnight's start time.
  const acceptingReschedule = row.kind === 'reschedule' && !declining;
  const { kinfolkId, batchId } = row.request;

  // #1098: the nights in this request waiting for the operator's start time.
  // Only an approval sets them; a decline books nothing and needs none.
  const nights = row.kind === 'newBooking' && !declining ? pendingVisits(row.request) : [];
  const [times, setTimes] = useState<Record<string, string>>({});
  const zone = useBusinessZone(nights.length > 0);
  // The overrides already granted with "Approve anyway", carried into every
  // retry so a busy override is not lost when the next attempt meets a visit
  // clash.
  const [granted, setGranted] = useState<ApproveOptions>({});
  const [retryKind, setRetryKind] = useState<'busy' | 'visit' | null>(null);
  const unset = nights.filter((v) => (times[v.visitId] ?? '') === '').length;
  const waitingOnZone = nights.length > 0 && zone.status === 'loading';

  function startTimesFor(): Record<string, number> | null {
    const out: Record<string, number> = {};
    // A failed read still resolves to the default, the zone the server uses
    // for a business with none saved, rather than to this device's clock.
    const businessZone = zone.status === 'ready' ? zone.zone : DEFAULT_BUSINESS_TIME_ZONE;
    for (const v of nights) {
      const ms = startTimeOnNight(v.requestedDate ?? '', times[v.visitId] ?? '', businessZone);
      if (ms === null) return null;
      out[v.visitId] = ms;
    }
    return out;
  }

  async function submit(overrides: ApproveOptions = granted) {
    setBusy(true);
    setError(null);
    setRetryKind(null);
    let options: ApproveOptions | undefined;
    if (nights.length > 0) {
      const startTimes = startTimesFor();
      if (startTimes === null) {
        setBusy(false);
        setError('One of those start times could not be read. Set it again.');
        return;
      }
      options = { startTimes, ...overrides };
    }
    try {
      const message = isNewRequest
        ? await submitNewRequest(kinfolkId, batchId, decision, note, options)
        : cancelling
          ? await submitCancel(kinfolkId, batchId, row.request.visitId, decision, note)
          : await submitReschedule(kinfolkId, batchId, row.request.visitId, decision, note, overrides);
      setBusy(false);
      onResolved(row, message);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'That did not go through. Try again.');
      if (nights.length > 0 || acceptingReschedule) {
        setGranted(overrides);
        setRetryKind(overridableApproveRefusal(err, overrides));
      }
    }
  }

  function approveAnyway() {
    if (retryKind === null) return;
    const next: ApproveOptions =
      retryKind === 'busy'
        ? { ...granted, overrideBusyConflict: true }
        : { ...granted, overrideVisitConflict: true };
    void submit(next);
  }

  function confirmText(): string {
    if (busy) return 'Working…';
    if (unset > 0) return nights.length === 1 ? 'Set the start time first' : 'Set the start times first';
    return confirmLabel(row.kind, decision);
  }

  return (
    <Dialog
      title={dialogTitle(row, decision)}
      onClose={onClose}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={busy} />
          <PrimaryButton
            label={confirmText()}
            onClick={() => void submit()}
            disabled={busy || unset > 0 || waitingOnZone}
          />
        </>
      }
    >
      <p className="visit-requests__dialog-household">
        {householdLabel(row)}
        <span className="visit-requests__dialog-subject">{rowSubject(row)}</span>
      </p>
      <p className="visit-requests__dialog-line">{dialogLine(row, decision)}</p>
      {nights.length > 0 && row.kind === 'newBooking' && (
        <ul className="visit-requests__nights">
          {nights.map((v) => {
            const name = nightFieldName(v, row.request);
            const id = `visit-request-start-${v.visitId}`;
            return (
              <li key={v.visitId} className="visit-requests__night">
                <span className="visit-requests__night-name">{name}</span>
                <label className="visit-requests__dialog-label" htmlFor={id}>
                  Start time
                </label>
                <input
                  id={id}
                  type="time"
                  className="visit-requests__night-time"
                  aria-label={`Start time for ${name}`}
                  value={times[v.visitId] ?? ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    setTimes((t) => ({ ...t, [v.visitId]: value }));
                    // A new time is a new question for the server: an override
                    // granted for the old one must not ride along with it.
                    setRetryKind(null);
                    setGranted({});
                  }}
                  disabled={busy}
                />
              </li>
            );
          })}
        </ul>
      )}
      {nights.length > 0 && zone.status === 'error' && (
        <Banner tone="warning" title={`Using ${DEFAULT_BUSINESS_TIME_ZONE}`}>
          {`Your business time zone did not load (${zone.message}), so these times are read in ${DEFAULT_BUSINESS_TIME_ZONE}. If your business is set to another zone, reload before approving.`}
        </Banner>
      )}
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
        <Banner
          tone="error"
          title="Not done"
          trailing={
            retryKind !== null && (
              <GhostButton
                label={acceptingReschedule ? 'Accept anyway' : 'Approve anyway'}
                onClick={approveAnyway}
                disabled={busy}
              />
            )
          }
        >
          {error}
        </Banner>
      )}
    </Dialog>
  );
}

type ZoneLoad =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; zone: string }
  | { status: 'error'; message: string };

/**
 * #1098: `business_settings.timeZone`, read once and only when the dialog has
 * a night to set, so an ordinary approval makes no extra read. The server
 * checks the chosen time against the night in this zone, so it is the zone the
 * wall clock is read in.
 */
function useBusinessZone(needed: boolean): ZoneLoad {
  const [load, setLoad] = useState<ZoneLoad>({ status: needed ? 'loading' : 'idle' });
  useEffect(() => {
    if (!needed) return undefined;
    let live = true;
    getBusinessSettings()
      .then((s) => {
        if (live) setLoad({ status: 'ready', zone: resolveBusinessTimeZone(s.timeZone) });
      })
      .catch((err: unknown) => {
        if (live) setLoad({ status: 'error', message: err instanceof Error ? err.message : 'read failed' });
      });
    return () => {
      live = false;
    };
  }, [needed]);
  return load;
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
  options?: ApproveOptions,
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
  // `options` only when a night needed its start time (#1098), so every other
  // request is approved with exactly the call it always made.
  const res =
    options === undefined
      ? await approveBookingRequest(kinfolkId, batchId)
      : await approveBookingRequest(kinfolkId, batchId, options);
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
  overrides: ApproveOptions = {},
): Promise<string> {
  // Overrides only once the operator has asked for one, so a first attempt is
  // exactly the call it always was.
  const res =
    overrides.overrideBusyConflict === true || overrides.overrideVisitConflict === true
      ? await resolveBookingRescheduleRequest(kinfolkId, batchId, visitId, decision, note, {
          ...(overrides.overrideBusyConflict === true && { overrideBusyConflict: true }),
          ...(overrides.overrideVisitConflict === true && { overrideVisitConflict: true }),
        })
      : await resolveBookingRescheduleRequest(kinfolkId, batchId, visitId, decision, note);
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

/** #1577: the title names the household, so nobody answers the wrong one. */
export function dialogTitle(row: VisitRequest, decision: 'accept' | 'decline'): string {
  if (row.kind === 'newBooking') {
    return decision === 'decline'
      ? `Turn down this request${forHousehold(row, 'from')}`
      : `Book this request${forHousehold(row, 'for')}`;
  }
  if (row.kind === 'cancel') {
    return decision === 'decline'
      ? `Keep this visit${forHousehold(row, 'for')}`
      : `Cancel this visit${forHousehold(row, 'for')}`;
  }
  return decision === 'decline'
    ? `Decline this new time${forHousehold(row, 'from')}`
    : `Move this visit${forHousehold(row, 'for')}`;
}

function confirmLabel(kind: VisitRequest['kind'], decision: 'accept' | 'decline'): string {
  if (decision === 'decline') return 'Send the decline';
  if (kind === 'newBooking') return 'Book it';
  return kind === 'cancel' ? 'Cancel it' : 'Move it';
}

function dialogLine(row: VisitRequest, decision: 'accept' | 'decline'): string {
  if (row.kind === 'newBooking') {
    // The dialog is where a night's time is set, so it names the night bare.
    const when = rowWhen(row, false);
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
