import { useEffect, useRef } from 'react';
import type { BookingEntry } from '../api/bookings';
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
 *
 * #2397: THE VISITS THEMSELVES GO UP, NOT ONLY THEIR IDS. The list draws the
 * 200 most recently created visits of every household, and a booking older
 * than that page has none of its visits on it, so highlighting by id matched
 * nothing while the banner still counted them. The records found here are
 * handed to the list, which draws the ones its page does not hold, so every
 * visit the banner counts is on the screen. They are the same
 * `kin_care_sessions` records the list reads, from a live read.
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
  const sessionIds = batchSessionsOf(sessions.data, focus).map((s) => s._id);
  return sessionIds.length > 0 ? { kind: 'booked', sessionIds } : { kind: 'gone' };
}
/** The household's visits that carry this booking's id, in the order read. Pure; unit-tested. */
export function batchSessionsOf<T extends SessionEntry>(sessions: readonly T[], focus: FocusRequest): T[] {
  const batchId = focus.batchId.trim();
  const kinfolkId = focus.kinfolkId.trim();
  return sessions.filter(
    (s) => str(s.kinCareBatchId).trim() === batchId && str(s.kinfolkId).trim() === kinfolkId,
  );
}
/**
 * Changes whenever the found visits do, in id or in content, so the list is
 * handed a fresh copy when one of them is moved or cancelled while the banner
 * is up. A record that cannot be written out falls back to its id.
 */
function contentKeyOf(found: readonly SessionEntry[]): string {
  try {
    return JSON.stringify(found);
  } catch {
    return found.map((s) => s._id).join('\n');
  }
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
  listStatus,
  onHighlight,
  onDismiss,
}: {
  focus: FocusRequest;
  /**
   * #2397: where the list's own read stands. The found visits are drawn on the
   * list, so "highlighted below" is only said once the list is drawn. While it
   * loads this keeps looking; when it failed this says nothing, and the list's
   * own error and Retry are what is on screen.
   */
  listStatus: Async<unknown>['status'];
  /**
   * The visits to highlight on the list, once found, and again whenever one of
   * them changes. The records, so the list can draw one its page does not hold.
   */
  onHighlight: (sessions: BookingEntry[]) => void;
  onDismiss: () => void;
}) {
  const sessions = useCollection<BookingEntry>(sessionsForKinfolkQuery(focus.kinfolkId));
  const state = batchFocusOf(sessions, focus);
  const found = sessions.status === 'ready' ? batchSessionsOf(sessions.data, focus) : [];
  const foundKey = found.length > 0 ? contentKeyOf(found) : '';
  const foundRef = useRef(found);
  foundRef.current = found;
  const onHighlightRef = useRef(onHighlight);
  onHighlightRef.current = onHighlight;
  // Another booking was opened: the last one's visits are not this one's.
  const focusKey = `${focus.kinfolkId}\n${focus.batchId}`;
  useEffect(() => {
    onHighlightRef.current([]);
  }, [focusKey]);
  const read = sessions.status === 'ready';
  useEffect(() => {
    // Only a finished read says what the booking holds. While the lookup has
    // failed or is being read again, the visits it last found stay on the
    // list: taking them off would drop a card the office has picked, and close
    // an open visit as unavailable, over a booking that is still there.
    if (!read) return;
    // Nothing found hands up nothing: a booking whose visits are gone has
    // none to draw, and the banner below says so.
    onHighlightRef.current(foundKey === '' ? [] : foundRef.current);
  }, [foundKey, read]);

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
      if (listStatus === 'error') return null;
      if (listStatus === 'loading') {
        return (
          <p className="bookings__hint" role="status" aria-live="polite">
            {BATCH_LOOKING_LABEL}
          </p>
        );
      }
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
