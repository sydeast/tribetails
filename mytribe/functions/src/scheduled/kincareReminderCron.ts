import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { paginateQuery } from '../lib/paginateCollectionGroup';
import { FULL_CPU_SERIAL } from '../lib/runtimeOptions';

const WINDOW_LOWER_MS = 24 * 60 * 60 * 1000;
const WINDOW_UPPER_MS = 48 * 60 * 60 * 1000;
const NOTIFIED_FIELD = 'upcomingReminderNotifiedAtMs';
const REMINDER_STATUSES = new Set(['confirmed', 'approved']);

type BookingDoc = {
  status?: string;
  serviceName?: string;
  serviceType?: string;
  title?: string;
  startTime?: { toMillis?: () => number } | null;
  [k: string]: unknown;
};

/**
 * Reminds on one confirmed/approved booking doc when it starts within the 24-48h
 * window and has not been reminded yet. Exported for unit testing. Returns true
 * when a reminder was enqueued.
 *
 * The status check is done in-memory (not as a Firestore .where() predicate) so
 * that the paginated collectionGroup scan can run without a composite index.
 * See runKincareReminderScan for details.
 */
export async function processUpcomingBooking(
  docSnap: QueryDocumentSnapshot,
  now: number,
): Promise<boolean> {
  const windowLower = now + WINDOW_LOWER_MS;
  const windowUpper = now + WINDOW_UPPER_MS;
  const data = docSnap.data() as BookingDoc;
  if (!REMINDER_STATUSES.has(data.status ?? '')) return false;
  if (data[NOTIFIED_FIELD]) return false;
  const startMs = data.startTime?.toMillis?.();
  if (!startMs) return false;
  if (startMs < windowLower || startMs > windowUpper) return false;
  const familyId = docSnap.ref.parent.parent?.id;
  if (!familyId) return false;
  const recipientUid = await resolveKinfolkUid(familyId);
  try {
    await enqueueNotification({
      key: 'kincare.upcoming.reminder',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId: familyId,
        bookingId: docSnap.id,
        serviceName: data.serviceName ?? data.serviceType ?? data.title ?? null,
        startTimeMs: startMs,
      },
      fireAtMs: now,
    });
    await docSnap.ref.set({ [NOTIFIED_FIELD]: now }, { merge: true });
    return true;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'kincareReminderCron',
      event: 'notification.dispatch.failed',
      extra: { familyId, bookingId: docSnap.id, err: (err as Error)?.message },
    });
    return false;
  }
}

/**
 * Drains the ENTIRE bookings collection-group, page by page (WARNING-25). The
 * status filter is applied in-memory inside processUpcomingBooking, NOT as a
 * Firestore .where() predicate. Reason: a filtered collectionGroup query
 * combined with .orderBy(__name__) requires a composite index
 * (bookings: status ASC, __name__ ASC) that we have not deployed. An
 * UNFILTERED collectionGroup().orderBy(documentId()) uses only the automatic
 * single-field index, so no composite index is needed. Exported for testing.
 */
export async function runKincareReminderScan(now: number = Date.now()): Promise<number> {
  let reminded = 0;
  await paginateQuery(
    db().collectionGroup('bookings'),
    async (docSnap) => {
      if (await processUpcomingBooking(docSnap, now)) reminded += 1;
    },
    { functionName: 'kincareReminderCron' },
  );
  return reminded;
}

/**
 * Runs hourly. Scans confirmed bookings starting 24-48h from now, enqueues
 * `kincare.upcoming.reminder` once per booking.
 */
export const kincareReminderCron = onSchedule(
  // Scans upcoming visits and fans out reminders inside the default 60s
  // timeout. See notificationDebounceSweep.
  {
    schedule: 'every 60 minutes',
    timeZone: 'America/New_York',
    secrets: ['SENTRY_DSN'],
    ...FULL_CPU_SERIAL,
  },
  wrapScheduled('kincareReminderCron', async () => {
    await runKincareReminderScan(Date.now());
  }),
);
