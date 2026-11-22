import { useEffect, useState } from 'react';
import { listPendingBookingRequests, type PendingBookingRequestDto } from '../api/bookingRequests';
import type { Async } from './async';
import { pendingRequestKey } from './notificationActions';
import { getTestScope } from './testScope';
import { useRefreshingLoad } from './useOneShot';
import { useVisitRequestSignal, type RequestQueueKind } from './visitRequestSignal';

/**
 * #1607: how often a request queue reads again while its screen is open, as
 * well as when it is told to (#1864's live signal) and when the tab returns.
 */
export const VISIT_REQUESTS_REFRESH_MS = 60_000;

/**
 * A number that goes up every [ms], and whenever the window regains focus or
 * the tab comes back into view. Part of a reload key.
 */
export function usePollTick(ms: number = VISIT_REQUESTS_REFRESH_MS): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const onVisible = () => {
      if (document.visibilityState === 'visible') bump();
    };
    const id = setInterval(bump, ms);
    window.addEventListener('focus', bump);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', bump);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ms]);
  return tick;
}

const NEW_REQUESTS: readonly RequestQueueKind[] = ['newBooking'];

/** #1877: when each read of the queue was sent, so an answer can outrank a read older than it. */
const queueReadSentAt = new WeakMap<ReadonlyMap<string, PendingBookingRequestDto>, number>();

/** Records when a queue read was sent. Exported for tests. */
export function markQueueReadSent<T extends ReadonlyMap<string, PendingBookingRequestDto>>(queue: T, sentAtMs: number): T {
  queueReadSentAt.set(queue, sentAtMs);
  return queue;
}

async function loadPending(): Promise<ReadonlyMap<string, PendingBookingRequestDto>> {
  const sentAtMs = Date.now();
  try {
    const { requests } = await listPendingBookingRequests();
    return markQueueReadSent(new Map(requests.map((r) => [pendingRequestKey(r.kinfolkId, r.batchId), r])), sentAtMs);
  } catch (err) {
    // A sandbox test admin may not read across households, so the queue is
    // refused for her on every visit. For her that is an empty queue, the
    // rule Android's Bookings applies to the same read, not a warning banner.
    if (getTestScope() !== null) return new Map();
    throw err;
  }
}

/**
 * #1877: the requests answered on this screen, each with when the server's
 * answer came back. A read sent after that moment speaks for the request, so
 * one that is somehow still waiting comes back. A read sent before it knows
 * nothing of the answer, however late it lands.
 */
export type AnsweredRequests = ReadonlyMap<string, number>;

export const NO_ANSWERED_REQUESTS: AnsweredRequests = new Map();

/** #1877: `answered` plus one more request, answered at `atMs`. */
export function withAnsweredRequest(
  answered: AnsweredRequests,
  key: string,
  atMs: number = Date.now(),
): AnsweredRequests {
  return new Map(answered).set(key, atMs);
}

/**
 * #1877: the queue, less the requests answered here since it was read. After
 * Approve the row read BOOKED while "Needs a decision" kept counting the
 * request until the next read of the queue, which can take ten seconds from
 * cold; a Deny happened to land sooner. The answer the server just confirmed
 * drops the request at once, for every count and button that reads the queue.
 */
export function pendingLessAnswered(
  queue: ReadonlyMap<string, PendingBookingRequestDto> | null,
  answered: AnsweredRequests,
): ReadonlyMap<string, PendingBookingRequestDto> | null {
  if (queue === null || answered.size === 0) return queue;
  const sentAtMs = queueReadSentAt.get(queue) ?? Number.NEGATIVE_INFINITY;
  const left = [...queue].filter(([key]) => {
    const answeredAtMs = answered.get(key);
    return answeredAtMs === undefined || sentAtMs > answeredAtMs;
  });
  return left.length === queue.size ? queue : new Map(left);
}

/**
 * #2069: the booking requests still waiting on the office, by
 * {@link pendingRequestKey}, read from the same callable the Bookings queue
 * reads and kept live the same way (#1864).
 *
 * This is the POSITIVE evidence a "Kinfolk requested a KinCare visit" row
 * needs before it may offer Approve or Deny. #1647 decided pendency from the
 * notification alone (its key, minus a `requestResolution` stamp the server
 * writes once a request is answered). Rows written before that stamp existed
 * never got one, so in November the August rows still offered Approve and
 * Deny on visits long since booked, and "Needs a decision" read 19 while
 * Bookings had 5 waiting. A request is waiting when the queue says so.
 */
export function usePendingBookingRequests(): Async<ReadonlyMap<string, PendingBookingRequestDto>> {
  const signal = useVisitRequestSignal(NEW_REQUESTS);
  const tick = usePollTick();
  return useRefreshingLoad(loadPending, 'pending booking requests', `${String(signal)}:${String(tick)}`);
}
