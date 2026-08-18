import { useState } from 'react';
import {
  listRescheduleRequests,
  resolveBookingRescheduleRequest,
  type RescheduleRequestDto,
} from '../api/rescheduleRequests';
import { bookingWhenLabel } from '../lib/bookingDetailFormat';
import { useOneShot } from '../lib/useOneShot';
import { type Async } from '../lib/async';
import { useToast } from './Toast';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import './RescheduleRequestsSection.css';

/**
 * Incoming reschedule requests (issue #399, item 2).
 *
 * A kinfolk can now propose a new time for a visit from the portal. Before this
 * section the office would have learned about it only from the
 * `kincare.reschedule.requested` notification, with nowhere to act on it, which
 * is exactly the shape the existing cancellation ask is still in: the flag has
 * been written to the visit since 2026-07-02 and no admin screen has ever
 * rendered it.
 *
 * Self-contained and modelled on `NeedsTriageSection`: it fetches its own queue
 * through a callable rather than a live listener, because the requests live in
 * the per-household `kinCares` subcollection and `useCollection` cannot express
 * a collection-group query. A resolved row is removed locally the moment the
 * server confirms the write, never re-fetched and never assumed.
 *
 * Silent while loading and silent when empty, because most days there is
 * nothing waiting and a section that may turn out empty should not flash a
 * skeleton above the Bookings list. A FAILED read is the one state that is
 * never silent: an operator who believes nothing is waiting, when really the
 * read never landed, leaves a household waiting on an answer that is never
 * coming.
 */

type DecisionSheet =
  | { kind: 'accept'; request: RescheduleRequestDto }
  | { kind: 'decline'; request: RescheduleRequestDto };

/** `1756738800000` -> "Tue, Sep 1 at 3:00 PM". "Not set" when the request carries no time. */
export function whenLabel(ms: number | null): string {
  if (ms === null) return 'Not set';
  return bookingWhenLabel(new Date(ms).toISOString());
}

/** The row's stable identity: a visit id is only unique inside its household. */
export function requestKey(r: RescheduleRequestDto): string {
  return `${r.kinfolkId}/${r.batchId}/${r.visitId}`;
}

export function RescheduleRequestsSection() {
  const loaded = useOneShot(() => listRescheduleRequests(), 'reschedule requests');
  const [resolvedKeys, setResolvedKeys] = useState<ReadonlySet<string>>(new Set());
  const [activeSheet, setActiveSheet] = useState<DecisionSheet | null>(null);
  const { showToast } = useToast();

  const state: Async<RescheduleRequestDto[]> =
    loaded.status === 'ready'
      ? { status: 'ready', data: loaded.data.requests.filter((r) => !resolvedKeys.has(requestKey(r))) }
      : loaded;

  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <Banner
        tone="error"
        title="Couldn't load reschedule requests"
        trailing={state.retry && <GhostButton label="Retry" onClick={state.retry} />}
      >
        {state.message}
      </Banner>
    );
  }
  if (state.data.length === 0) return null;

  function onResolved(request: RescheduleRequestDto, message: string) {
    setResolvedKeys((prev) => new Set(prev).add(requestKey(request)));
    setActiveSheet(null);
    showToast(message);
  }

  return (
    <section className="reschedule-requests">
      <Banner
        tone="warning"
        title="Reschedule requests"
        pillLabel={`${String(state.data.length)} waiting`}
      >
        A household asked to move these visits. Accepting moves the visit to the proposed time on both
        the schedule and their portal. Declining leaves it where it is and sends them your reason.
      </Banner>

      <ul className="reschedule-requests__list">
        {state.data.map((request) => (
          <li key={requestKey(request)} className="reschedule-requests__row">
            <div className="reschedule-requests__row-meta">
              <span className="reschedule-requests__row-title">
                {request.title ?? request.serviceType ?? 'Visit'}
              </span>
              {request.kinNames.length > 0 && (
                <>
                  <span className="reschedule-requests__row-dot" aria-hidden="true">
                    ·
                  </span>
                  <span>{request.kinNames.join(', ')}</span>
                </>
              )}
            </div>
            <p className="reschedule-requests__row-when">
              {`${whenLabel(request.currentStartTimeMs)} → ${whenLabel(request.proposedStartTimeMs)}`}
            </p>
            {request.reason !== null && (
              <p className="reschedule-requests__row-reason">{request.reason}</p>
            )}
            <div className="reschedule-requests__row-actions">
              <PrimaryButton label="Accept" onClick={() => setActiveSheet({ kind: 'accept', request })} />
              <GhostButton label="Decline" onClick={() => setActiveSheet({ kind: 'decline', request })} />
            </div>
          </li>
        ))}
      </ul>

      {activeSheet && (
        <DecisionDialog
          sheet={activeSheet}
          onClose={() => setActiveSheet(null)}
          onResolved={onResolved}
        />
      )}
    </section>
  );
}

interface DecisionDialogProps {
  sheet: DecisionSheet;
  onClose: () => void;
  onResolved: (request: RescheduleRequestDto, message: string) => void;
}

/**
 * Confirm copy is written in the future tense and the confirm button never
 * repeats the trigger's label, per the convention `screens/BookingActions.tsx`
 * sets for every other booking decision in this app.
 */
function DecisionDialog({ sheet, onClose, onResolved }: DecisionDialogProps) {
  const { request, kind } = sheet;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const declining = kind === 'decline';
  const noteMissing = declining && note.trim().length === 0;

  async function submit() {
    if (noteMissing) {
      setError('Say why the time does not work. The household sees this on their booking.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await resolveBookingRescheduleRequest(
        request.kinfolkId,
        request.batchId,
        request.visitId,
        kind,
        note,
      );
      setBusy(false);
      onResolved(
        request,
        declining
          ? 'Declined. The household will see your reason on their booking.'
          : res.sessionUpdated
            ? 'Moved. The schedule and the household now show the new time.'
            : 'Moved. This visit is still a request, so it has no schedule row to move yet.',
      );
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'That did not go through. Try again.');
    }
  }

  return (
    <Dialog
      title={declining ? 'Decline this new time' : 'Move this visit'}
      onClose={onClose}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={busy} />
          <PrimaryButton
            label={busy ? 'Working…' : declining ? 'Send the decline' : 'Move it'}
            onClick={() => void submit()}
            disabled={busy}
          />
        </>
      }
    >
      <p className="reschedule-requests__dialog-line">
        {declining
          ? `${whenLabel(request.proposedStartTimeMs)} will not be booked. The visit stays at ${whenLabel(request.currentStartTimeMs)}.`
          : `This visit will move from ${whenLabel(request.currentStartTimeMs)} to ${whenLabel(request.proposedStartTimeMs)}.`}
      </p>
      <label className="reschedule-requests__dialog-label" htmlFor="reschedule-note">
        {declining ? 'Why it does not work' : 'Note for the household (optional)'}
      </label>
      <textarea
        id="reschedule-note"
        className="reschedule-requests__dialog-note"
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
