import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { enqueueNotification } from '../notifications/dispatcher';

const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

type BookingDoc = {
  status?: string;
  serviceName?: string;
  serviceType?: string;
  title?: string;
  auntieDisplayName?: string;
  startTime?: { toMillis?: () => number } | null;
};

/**
 * Runs daily 07:00 ET. Builds a digest of next-24h confirmed bookings
 * and enqueues `schedule.upcoming.digest` for businessAdmins.
 */
export const scheduleDigestCron = onSchedule(
  { schedule: 'every day 07:00', timeZone: 'America/New_York', secrets: ['SENTRY_DSN'] },
  wrapScheduled('scheduleDigestCron', async () => {
    const now = Date.now();
    const windowEnd = now + DIGEST_WINDOW_MS;
    const snap = await db()
      .collectionGroup('bookings')
      .where('status', 'in', ['confirmed', 'approved'])
      .limit(1000)
      .get();
    const items: Array<Record<string, unknown>> = [];
    for (const docSnap of snap.docs) {
      const data = docSnap.data() as BookingDoc;
      const startMs = data.startTime?.toMillis?.();
      if (!startMs) continue;
      if (startMs < now || startMs > windowEnd) continue;
      const familyId = docSnap.ref.parent.parent?.id;
      items.push({
        bookingId: docSnap.id,
        kinfolkId: familyId ?? null,
        serviceName: data.serviceName ?? data.serviceType ?? data.title ?? null,
        auntieDisplayName: data.auntieDisplayName ?? null,
        startTimeMs: startMs,
      });
    }
    if (items.length === 0) return;
    items.sort((a, b) => (a.startTimeMs as number) - (b.startTimeMs as number));
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
