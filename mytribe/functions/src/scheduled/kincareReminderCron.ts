import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotificationDetailed } from '../notifications/dispatcher';
import { paginateQuery } from '../lib/paginateCollectionGroup';
import { isAutoReminder24hEnabled } from '../lib/autoReminder';
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
 *
 * `upcomingReminderNotifiedAtMs` MEANS "A REMINDER REACHED THIS HOUSEHOLD", and
 * `:43` above skips on it forever, so it is written only when one did. It used
 * to be stamped on any enqueue that did not throw, which is a different claim:
 * `kincare.upcoming.reminder` is kinfolk-only with `required: {}`, so a
 * household that turns email off, an operator gate on the row, or (now) the
 * pre-launch household gate all return an empty `written` without throwing, and
 * the booking was marked reminded having heard nothing.
 *
 * That was survivable while the only causes were standing preferences. It stops
 * being survivable with a launch switch: while the gate is shut EVERY household
 * copy is suppressed, so every booking in the 24-48h window would be stamped
 * reminded, and the day the operator opens the product not one of them would be
 * reminded, ever. Same reasoning, same three branches and same vocabulary as
 * `invoiceRemindersCron.processReminderInvoice`, which is where this shape
 * comes from:
 *
 *   - written:    a reminder went out now. Stamp now.
 *   - duplicate:  one already went out inside the dispatcher's window and its
 *                 stamp did not land. Stamp THAT time; send nothing.
 *   - otherwise:  nothing was delivered. Stamp nothing, so the booking stays
 *                 eligible. The window is 24 hours wide and the cron runs
 *                 hourly, so it gets many more attempts.
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
    const outcome = await enqueueNotificationDetailed({
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
    if (outcome.written.length > 0) {
      await docSnap.ref.set({ [NOTIFIED_FIELD]: now }, { merge: true });
      return true;
    }
    const duplicate = outcome.suppressed.find((s) => s.reason === 'duplicate');
    if (duplicate) {
      await docSnap.ref.set({ [NOTIFIED_FIELD]: duplicate.lastAtMs ?? now }, { merge: true });
    }
    logEvent({
      severity: 'info',
      function: 'kincareReminderCron',
      event: duplicate ? 'reminder.already-delivered' : 'reminder.suppressed',
      extra: {
        familyId,
        bookingId: docSnap.id,
        lastAtMs: duplicate?.lastAtMs ?? null,
        reasons: outcome.suppressed.map((s) => s.reason),
      },
    });
    return false;
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
 *
 * ISSUE #519: the scan is gated on `business_settings.enableAutoReminder24h`
 * ("Send a reminder 24 hours before a visit"), read ONCE per run rather than
 * per booking — the answer cannot change mid-scan in a way that should split a
 * single hour's reminders in two, and one document read is not worth repeating
 * across a whole collection-group drain. Off means the scan does not run at
 * all: no pagination, no `upcomingReminderNotifiedAtMs` stamps, so turning the
 * switch back on still reminds about the visits that came due while it was off
 * (their window is 24-48h wide, an hourly cron gets many attempts at it).
 * Absent decodes as ON; see `lib/autoReminder.ts` for why that is not optional.
 */
export async function runKincareReminderScan(now: number = Date.now()): Promise<number> {
  if (!(await isAutoReminder24hEnabled(db()))) {
    logEvent({
      severity: 'info',
      function: 'kincareReminderCron',
      event: 'kincare.reminder.disabled',
      extra: { reason: 'enableAutoReminder24h=false' },
    });
    return 0;
  }
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
