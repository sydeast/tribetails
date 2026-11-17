import { useEffect, useRef } from 'react';
import { sessionsForKinfolkQuery, type SessionEntry } from '../api/sessions';
import { useCollection } from '../lib/firestore';
import { str } from '../lib/coerce';
import type { Async } from '../lib/async';
import { Banner } from './Banner';
import { GhostButton } from './Buttons';
import type { FocusRequest } from './VisitRequestsSection';

/**
 * #2367: OPEN ON A WHOLE BOOKING, ONCE ITS REQUEST IS NO LONGER WAITING.
 *
 * Open on a notice about a whole booking (`kincare.booking.confirm`, an
 * Auntie's assignment, a request) lands on Bookings with
 * `?requestId=&requestKinfolkId=` (#2028). While the request is still waiting,
 * the Visit requests queue opens its card. Once it has been answered, the queue
 * no longer holds it, and before this the screen said the request was no
 * longer waiting, which reads as "gone" for a booking that is on the schedule.
 *
 * A booked request is its visits: every `kin_care_sessions` record approval
 * made from it carries the request's id as `kinCareBatchId`. They are found
 * here from the household's own sessions read, not from the Bookings page,
 * which is the 200 newest records and cannot prove a booking is gone. Found,
 * the list highlights them; none, the booking is no longer available.
 */

/** What became of the booking, from the household's sessions. Pure; unit-tested. */
export type BatchFocus =
  | { kind: 'looking' }
  | { kind: 'failed'; message: string; retry?: () => void }
  | { kind: 'booked'; sessionIds: string[] }
  | { kind: 'gone' };

export function batchFocusOf(sessions: Async<SessionEntry[]>, focus: FocusRequest): BatchFocus {
  if (sessions.status === 'loading') return { kind: 'looking' };
  if (sessions.status === 'error') {
    return { kind: 'failed', message: sessions.message, ...(sessions.retry ? { retry: sessions.retry } : {}) };
  }
  const batchId = focus.batchId.trim();
  const kinfolkId = focus.kinfolkId.trim();
  const sessionIds = sessions.data
    .filter((s) => str(s.kinCareBatchId).trim() === batchId && str(s.kinfolkId).trim() === kinfolkId)
    .map((s) => s._id);
  return sessionIds.length > 0 ? { kind: 'booked', sessionIds } : { kind: 'gone' };
}

/** The banner line for a booked request's visits. */
export function bookedLine(count: number): string {
  return count === 1 ? 'Its visit is highlighted below.' : `Its ${String(count)} visits are highlighted below.`;
}

export const BATCH_LOOKING_LABEL = 'Looking this booking up…';
export const BATCH_BOOKED_TITLE = 'This booking';
export const BATCH_GONE_TITLE = 'This booking is no longer available';
export const BATCH_GONE_LINE = 'It was turned down, withdrawn or removed, so there is nothing to open.';
export const BATCH_FAILED_TITLE = "Couldn't look this booking up";

export function BookingBatchFocus({
  focus,
  onHighlight,
  onDismiss,
}: {
  focus: FocusRequest;
  /** The visits to highlight on the list, once found. */
  onHighlight: (sessionIds: string[]) => void;
  onDismiss: () => void;
}) {
  const sessions = useCollection<SessionEntry>(sessionsForKinfolkQuery(focus.kinfolkId));
  const state = batchFocusOf(sessions, focus);
  const foundKey = state.kind === 'booked' ? state.sessionIds.join('\n') : '';
  const onHighlightRef = useRef(onHighlight);
  onHighlightRef.current = onHighlight;
  useEffect(() => {
    if (foundKey !== '') onHighlightRef.current(foundKey.split('\n'));
  }, [foundKey]);

  switch (state.kind) {
    case 'looking':
      return (
        <p className="bookings__hint" role="status" aria-live="polite">
          {BATCH_LOOKING_LABEL}
        </p>
      );
    case 'failed':
      return (
        <Banner
          tone="error"
          title={BATCH_FAILED_TITLE}
          onDismiss={onDismiss}
          {...(state.retry ? { trailing: <GhostButton label="Retry" onClick={state.retry} /> } : {})}
        >
          {state.message}
        </Banner>
      );
    case 'booked':
      return (
        <Banner tone="info" title={BATCH_BOOKED_TITLE} onDismiss={onDismiss}>
          <span role="status">{bookedLine(state.sessionIds.length)}</span>
        </Banner>
      );
    case 'gone':
      return (
        <Banner tone="info" title={BATCH_GONE_TITLE} onDismiss={onDismiss}>
          {BATCH_GONE_LINE}
        </Banner>
      );
  }
}
