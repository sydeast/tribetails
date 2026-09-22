import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { enqueueNotificationDetailed } from '../notifications/dispatcher';
import { paginateQuery } from '../lib/paginateCollectionGroup';
import { FULL_CPU_SERIAL } from '../lib/runtimeOptions';
import { HOURLY_TICK, runHourlyTick } from '../lib/notificationSchedule';

const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const DIGEST_STATUSES = new Set(['confirmed', 'approved']);

/**
 * The event id of one business day's digest, so a second run of the same day
 * sends nothing.
 *
 * THIS DID NOT EXIST AND HAD TO. The enqueue below passed no `dedupeKey`, so it
 * fell to the dispatcher's derived identity and its five-minute default window,
 * and two scans in one day sent two digests. That was safe only while Cloud
 * Scheduler fired this function once a day. It stopped being safe the moment the
 * function started ticking hourly, so it is fixed in the same change rather than
 * left as a trap the new cadence springs.
 *
 * It is not made redundant by the run marker; the two guard different things. The
 * marker is the COST gate, stopping the collection-group drain, which is the
 * expensive part. This is the CRASH NET, covering the one ordering the marker
 * cannot cover itself: the enqueue lands and the marker write then fails.
 *
 * Keyed on the BUSINESS day rather than on the digest's contents, because the
 * contents legitimately change between two runs of one day (a booking confirmed
 * at noon joins the list) and a content key would read that as a new event and
 * send a second brief. One day, one brief.
 */
export function scheduleDigestDedupeKey(dayIso: string): string {
  return `schedule.digest:${dayIso}`;
}

/**
 * How far back the ledger looks for this day's digest. Wider than a day, so the
 * 25-hour day in autumn and a tick that runs late still meet the earlier send
 * rather than stepping past it.
 */
export const DIGEST_DEDUPE_WINDOW_MS = 30 * 60 * 60 * 1000;

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
 * Builds and sends one business day's digest. Exported so the double-send tests
 * can drive two runs of the same day without a Cloud Scheduler tick.
 */
export async function sendScheduleDigest(now: number, dayIso: string): Promise<void> {
  const windowEnd = now + DIGEST_WINDOW_MS;
  const items = await runScheduleDigestScan(now);
  if (items.length === 0) return;
  try {
    const outcome = await enqueueNotificationDetailed({
      key: 'schedule.upcoming.digest',
      recipientUid: '',
      data: { windowStartMs: now, windowEndMs: windowEnd, count: items.length, items },
      fireAtMs: now,
      dedupeKey: scheduleDigestDedupeKey(dayIso),
      dedupeWindowMs: DIGEST_DEDUPE_WINDOW_MS,
    });
    if (outcome.written.length === 0) {
      logEvent({
        severity: 'info',
        function: 'scheduleDigestCron',
        event: 'digest.suppressed',
        extra: {
          dayIso,
          count: items.length,
          reasons: outcome.suppressed.map((s) => s.reason),
        },
      });
    }
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'scheduleDigestCron',
      event: 'notification.dispatch.failed',
      extra: { count: items.length, err: (err as Error)?.message },
    });
  }
}

/**
 * Ticks hourly. Acts once per business day, at `scheduleDigestHour`, building a
 * digest of next-24h confirmed bookings and enqueuing `schedule.upcoming.digest`
 * for businessAdmins.
 *
 * IT SHIPS WITH NO HOUR AND THEREFORE SENDS NOTHING, by the ruling in
 * `lib/notificationSchedule.ts`. It used to run at 07:00 `America/New_York`, so
 * this does stop a job that was running. That is the ruling's intent rather than
 * a side effect of it, and there is nothing to digest meanwhile: the product is
 * pre-launch and the operator turns it on with one picker when they want it.
 *
 * IT HAS ITS OWN HOUR, separate from the two invoice crons', because it has a
 * different audience. This is the operator's own brief of the day ahead. No
 * household ever sees it and Phase 1's household send gate does not hold it, so
 * one shared hour would mean the operator could not move their own brief earlier
 * than the household notices without moving both, which is exactly the
 * arrangement the old 07:00 and 09:00 had.
 */
export const scheduleDigestCron = onSchedule(
  // Builds and sends the daily schedule digest inside the default 60s
  // timeout. See notificationDebounceSweep.
  {
    ...HOURLY_TICK,
    secrets: ['SENTRY_DSN'],
    ...FULL_CPU_SERIAL,
  },
  wrapScheduled('scheduleDigestCron', async () => {
    const now = Date.now();
    await runHourlyTick({
      firestore: db(),
      functionName: 'scheduleDigestCron',
      nowMs: now,
      pickHour: (s) => s.digestHour,
      scan: (dayIso) => sendScheduleDigest(now, dayIso),
    });
  }),
);
