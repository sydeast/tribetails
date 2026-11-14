import { useEffect, useState } from 'react';
import { collectionGroup, limit, onSnapshot, orderBy, query, where, type Query } from 'firebase/firestore';
import { db } from './firebase';
import { getTestScope } from './testScope';

/**
 * #1864: a live nudge for the household request queues.
 *
 * The queues themselves are read through callables (`listPendingBookingRequests`,
 * `listRescheduleRequests`, `listCancelRequests`): the server resolves the
 * household names, the KinCare lengths and the July backlog's missing status
 * field, and no client should copy that. What the queues lacked was a reason to
 * read again. #1607 gave them a 60-second poll, and the walk watched for 70
 * seconds after a Kinfolk filed a request while the waiting count stood still:
 * one tick, plus a callable that can take ten seconds from cold, is not live.
 *
 * So this listens to the same `kinCares` documents the three callables read,
 * with the same query shapes, which the existing indexes already serve:
 *   - new requests:  `status == 'requested'` (collection-group `status` index)
 *   - new times:     `rescheduleRequestStatus == 'pending'` ordered by
 *                    `rescheduleRequestedAt` (the composite the server uses)
 *   - cancellations: ordered by `cancelRequestedAt` (its collection-group index;
 *                    the July backlog has no status field to filter on)
 * Every change after a listener's first snapshot bumps the returned number,
 * and the caller reads its queue again. The first snapshot is the state the
 * caller's own first read already has, so it is not a change.
 *
 * Staff may read `kinCares` at collection-group scope (firestore.rules,
 * "kinCares collection-group read"). A sandbox test admin may not, so nothing
 * listens for one, and a listener that fails stays quiet: the caller's poll is
 * still running, and the callables report their own failures on screen.
 */
export type RequestQueueKind = 'newBooking' | 'reschedule' | 'cancel';

/**
 * A bound on every listener. Above the list callables' own scan cap (200), so
 * anything they can list is watched.
 */
const SCAN_CAP = 500;

function queryFor(kind: RequestQueueKind): Query {
  const visits = collectionGroup(db, 'kinCares');
  switch (kind) {
    case 'newBooking':
      return query(visits, where('status', '==', 'requested'), limit(SCAN_CAP));
    case 'reschedule':
      return query(
        visits,
        where('rescheduleRequestStatus', '==', 'pending'),
        orderBy('rescheduleRequestedAt', 'asc'),
        limit(SCAN_CAP),
      );
    case 'cancel':
      return query(visits, orderBy('cancelRequestedAt', 'asc'), limit(SCAN_CAP));
  }
}

/**
 * A number that goes up whenever a watched queue changes. Use it as part of a
 * reload key. [kinds] is read once per distinct joined value, so pass a
 * constant array.
 */
export function useVisitRequestSignal(kinds: readonly RequestQueueKind[]): number {
  const [signal, setSignal] = useState(0);
  const key = [...kinds].sort().join(',');
  useEffect(() => {
    if (getTestScope() !== null || key === '') return undefined;
    const stops: Array<() => void> = [];
    for (const kind of key.split(',') as RequestQueueKind[]) {
      let first = true;
      try {
        stops.push(
          onSnapshot(
            queryFor(kind),
            () => {
              if (first) {
                first = false;
                return;
              }
              setSignal((n) => n + 1);
            },
            // Quiet on purpose: see the header. The poll and the callables'
            // own error banners still cover this queue.
            () => undefined,
          ),
        );
      } catch {
        /* a query that cannot be built leaves this queue on its poll */
      }
    }
    return () => {
      for (const stop of stops) stop();
    };
  }, [key]);
  return signal;
}
