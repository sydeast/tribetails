import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';

/**
 * #1647: the office's "Kinfolk requested a KinCare visit" notification learns
 * how its request ended.
 *
 * `kincare.requested` is written ONCE, at the moment of the ask
 * (onBookingEnvelopeCreate), and nothing ever told it the request had since
 * been booked or declined. Every admin client read pendency off the key alone
 * (#706), so a request booked from Bookings > Review kept offering Approve and
 * Deny on its notification, and "Needs a decision" kept counting it.
 *
 * The fix is a stamp on the notification docs themselves, so every client reads
 * the same answer from the row it already has:
 *
 *   requestResolution   'booked' | 'declined' | 'cancelled'
 *   requestResolvedAt   server timestamp of the stamp
 *
 * STAFF DOCS ONLY, NOTHING SENT. This updates existing `notifications` rows in
 * place. It never calls `enqueueNotification`, never writes a
 * `notificationDispatch` work order and never touches the dedupe ledger, so the
 * household send gate (`householdNotificationsLive`) is not involved: no
 * message to anyone is created here. `kincare.requested` is business-audience
 * only (catalog.ts), so every row this touches is a staff row.
 */
export type RequestResolution = 'booked' | 'declined' | 'cancelled';

/** The notification key whose rows this stamps. */
export const REQUEST_NOTIFICATION_KEY = 'kincare.requested';

/** Envelope statuses that mean at least part of the request is on the schedule. */
const BOOKED_STATUSES = new Set(['confirmed', 'partiallyConfirmed', 'inProgress', 'completed']);

/**
 * How a request ended, from the envelope's status change, or null when the
 * change says nothing new about the request.
 *
 * - Anything into a booked status is 'booked'. That includes a declined request
 *   approved again later (`cancelled -> confirmed`), which IS a new answer, so
 *   the row's "Declined" becomes "Booked".
 * - `requested -> cancelled` is the request being turned away before anyone
 *   booked it. `declined` when the office declined it (manageBookingSeries
 *   CANCEL marks each visit `requestDeclinedAt`, #533), `cancelled` otherwise
 *   (the household withdrew it, or a visit-level REJECT/CANCEL emptied it).
 * - A series that was booked and is cancelled later stays 'booked': the request
 *   WAS booked, and the cancellation has notifications of its own.
 * - Moves between booked statuses (`confirmed -> completed`) return null, so the
 *   caller does not query for a stamp it already wrote.
 *
 * Pure; unit-tested.
 */
export function requestResolutionForTransition(
  before: string | undefined,
  after: string | undefined,
  anyVisitDeclined: boolean,
): RequestResolution | null {
  if (after === undefined || before === after) return null;
  if (BOOKED_STATUSES.has(after)) {
    return before !== undefined && BOOKED_STATUSES.has(before) ? null : 'booked';
  }
  if (after === 'cancelled' && before === 'requested') {
    return anyVisitDeclined ? 'declined' : 'cancelled';
  }
  return null;
}

/** True when any visit carries the decline marker manageBookingSeries writes. */
export function anyVisitDeclined(visits: ReadonlyArray<Record<string, unknown>>): boolean {
  return visits.some((v) => v['requestDeclinedAt'] !== undefined && v['requestDeclinedAt'] !== null);
}

/**
 * Stamps every `kincare.requested` notification for envelope [batchId] with
 * [resolution]. Returns how many rows it wrote.
 *
 * Queried on `targetId` alone and filtered on `key` here, so the query rides the
 * automatic single-field index and needs no composite one. A request's batchId
 * is unique, so the match set is the request's own handful of rows (one per
 * business admin) plus any envelope-grain notification about the same request.
 *
 * Rows already carrying this resolution are skipped, so a repeat is a no-op.
 *
 * NEVER THROWS. The request has already been booked or declined by the time
 * this runs, and a notification row that is late to say so must not fail or
 * retry the thing that actually happened. A failure is logged loud instead.
 */
export async function stampRequestNotifications(
  args: { kinfolkId: string; batchId: string; resolution: RequestResolution; source: string },
): Promise<number> {
  const { kinfolkId, batchId, resolution, source } = args;
  try {
    const snap = await db().collection('notifications').where('targetId', '==', batchId).get();
    const due = snap.docs.filter((d) => {
      const data = (d.data() ?? {}) as Record<string, unknown>;
      return data['key'] === REQUEST_NOTIFICATION_KEY && data['requestResolution'] !== resolution;
    });
    if (due.length === 0) return 0;
    const batch = db().batch();
    for (const d of due) {
      batch.update(d.ref, {
        requestResolution: resolution,
        requestResolvedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    logEvent({
      severity: 'info',
      function: source,
      event: 'notification.request.resolved',
      extra: { kinfolkId, batchId, resolution, stamped: due.length },
    });
    return due.length;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: source,
      event: 'notification.request.resolve.failed',
      extra: { kinfolkId, batchId, resolution, err: (err as Error)?.message },
    });
    return 0;
  }
}
