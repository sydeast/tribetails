import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { enqueueNotification } from '../notifications/dispatcher';
import { paginateQuery } from '../lib/paginateCollectionGroup';

const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const DIGEST_STATUSES = new Set(['confirmed', 'approved']);

type BookingDoc = {
  status?: string;
  serviceName?: string;
  serviceType?: string;
  title?: string;
  auntieDisplayName?: string;
  startTime?: { toMillis?: () => number } | null;
};

/**
 * Builds the next-24h digest of confirmed/approved bookings by draining the
 * ENTIRE bookings collection-group page by page (WARNING-25). The old single
 * `.limit(1000)` silently dropped every upcoming booking past the cap from the
 * digest — the exact leg the WARNING-25 remediation paginated for
 * invoiceRemindersCron and kincareReminderCron but never applied here.
 *
 * The status + 24h-window filter runs IN-MEMORY inside the page callback, not
 * as a Firestore `.where()`, because a filtered collection-group query combined
 * with `.orderBy(__name__)` requires a composite index we have not deployed; an
 * unfiltered `collectionGroup().orderBy(documentId())` uses only the automatic
 * single-field index (same rationale as kincareReminderCron). Exported for testing.
 */
export async function runScheduleDigestScan(
  now: number = Date.now(),
): Promise<Array<Record<string, unknown>>> {
  const windowEnd = now + DIGEST_WINDOW_MS;
  const items: Array<Record<string, unknown>> = [];
  await paginateQuery(
    db().collectionGroup('bookings'),
    (docSnap) => {
      const data = docSnap.data() as BookingDoc;
      if (!data.status || !DIGEST_STATUSES.has(data.status)) return;
      const startMs = data.startTime?.toMillis?.();
      if (!startMs) return;
      if (startMs < now || startMs > windowEnd) return;
      const familyId = docSnap.ref.parent.parent?.id;
      items.push({
        bookingId: docSnap.id,
        kinfolkId: familyId ?? null,
        serviceName: data.serviceName ?? data.serviceType ?? data.title ?? null,
        auntieDisplayName: data.auntieDisplayName ?? null,
        startTimeMs: startMs,
      });
    },
    { functionName: 'scheduleDigestCron' },
  );
  items.sort((a, b) => (a.startTimeMs as number) - (b.startTimeMs as number));
  return items;
}

/**
 * Runs daily 07:00 ET. Builds a digest of next-24h confirmed bookings
 * and enqueues `schedule.upcoming.digest` for businessAdmins.
 */
export const scheduleDigestCron = onSchedule(
  { schedule: 'every day 07:00', timeZone: 'America/New_York', secrets: ['SENTRY_DSN'] },
  wrapScheduled('scheduleDigestCron', async () => {
    const now = Date.now();
    const windowEnd = now + DIGEST_WINDOW_MS;
    const items = await runScheduleDigestScan(now);
    if (items.length === 0) return;
    try {
      await enqueueNotification({
        key: 'schedule.upcoming.digest',
        data: { windowStartMs: now, windowEndMs: windowEnd, count: items.length, items },
        fireAtMs: now,
      });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'scheduleDigestCron',
        event: 'notification.dispatch.failed',
        extra: { count: items.length, err: (err as Error)?.message },
      });
    }
  }),
);
