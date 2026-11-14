import { useEffect, useState } from 'react';
import { listPendingBookingRequests, type PendingBookingRequestDto } from '../api/bookingRequests';
import type { Async } from './async';
import { pendingRequestKey } from './notificationActions';
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

async function loadPending(): Promise<ReadonlyMap<string, PendingBookingRequestDto>> {
  const { requests } = await listPendingBookingRequests();
  return new Map(requests.map((r) => [pendingRequestKey(r.kinfolkId, r.batchId), r]));
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
