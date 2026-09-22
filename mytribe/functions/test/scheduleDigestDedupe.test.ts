import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn(), sentryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: mocks.sentryFn }));
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  mocks.sentryFn.mockReset();
});

import {
  DIGEST_DEDUPE_WINDOW_MS,
  scheduleDigestDedupeKey,
  sendScheduleDigest,
} from '../src/scheduled/scheduleDigestCron';

/**
 * ONE BUSINESS DAY, ONE DIGEST.
 *
 * `scheduleDigestCron` had NO per-day guard. It called `enqueueNotification`
 * with no `dedupeKey`, so it fell to the dispatcher's derived identity and its
 * five-minute default window, and two runs in one day sent two digests. That was
 * safe only while Cloud Scheduler fired the function once a day, and it stopped
 * being safe the moment the function started ticking hourly.
 *
 * The run marker (`lib/notificationSchedule.ts`) is the cost gate and stops the
 * second scan. This is the crash net underneath it, for the one ordering the
 * marker cannot cover: the enqueue lands and the marker write then fails.
 */

const ADMINS_PATH = 'businessSettings/admins';
const DAY = '2026-09-22';
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const SOON = NOW + 3 * 60 * 60 * 1000;

/**
 * Two confirmed bookings, one in each of the next two days' windows. The scan's
 * window is `[now, now + 24h]`, so a single fixture booking would make the
 * next-day test pass or fail on the fixture rather than on the dedupe key.
 */
function bookingFixture() {
  return {
    bookings: [
      {
        id: 'bk1',
        path: 'families/kf1/bookings/bk1',
        data: {
          status: 'confirmed',
          serviceName: 'Morning visit',
          startTime: { toMillis: () => SOON },
        },
      },
      {
        id: 'bk2',
        path: 'families/kf1/bookings/bk2',
        data: {
          status: 'confirmed',
          serviceName: 'Next-day visit',
          startTime: { toMillis: () => SOON + 24 * 60 * 60 * 1000 },
        },
      },
    ],
  };
}

function ctxFor() {
  const ctx = buildDbMock({
    docs: { [ADMINS_PATH]: { uids: ['op1'] } },
    collectionGroupDocs: bookingFixture(),
    writeThrough: true,
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

/** Digest dispatches land in `scheduledNotifications`; the deliveryMode is 'scheduled'. */
const digestWrites = (ctx: ReturnType<typeof buildDbMock>): unknown[] =>
  ctx.writes.filter((w) => w.path.startsWith('scheduledNotifications/'));

describe('scheduleDigestDedupeKey', () => {
  /**
   * Keyed on the BUSINESS day, not on the digest's contents. The contents
   * legitimately change between two runs of one day (a booking confirmed at noon
   * joins the list), and a content key would read that as a new event and send a
   * second brief.
   */
  it('names the day and nothing else', () => {
    expect(scheduleDigestDedupeKey(DAY)).toBe('schedule.digest:2026-09-22');
    expect(scheduleDigestDedupeKey('2026-09-23')).not.toBe(scheduleDigestDedupeKey(DAY));
  });

  /** Wider than a day, so the 25-hour day in autumn still meets the earlier send. */
  it('looks back further than one day', () => {
    expect(DIGEST_DEDUPE_WINDOW_MS).toBeGreaterThan(24 * 60 * 60 * 1000);
  });
});

describe('the digest sends once per business day', () => {
  it('a first run of the day sends', async () => {
    const ctx = ctxFor();
    await sendScheduleDigest(NOW, DAY);
    expect(digestWrites(ctx).length).toBe(1);
  });

  /**
   * THE REGRESSION THIS GUARDS. Watched fail against the pre-change
   * `enqueueNotification` call with no dedupe key, which sent twice.
   */
  it('a SECOND run of the same day sends nothing', async () => {
    const ctx = ctxFor();
    await sendScheduleDigest(NOW, DAY);
    expect(digestWrites(ctx).length, 'the first run').toBe(1);

    // An hour later, the marker write having failed, the tick tries again.
    await sendScheduleDigest(NOW + 60 * 60 * 1000, DAY);
    expect(digestWrites(ctx).length, 'still one digest').toBe(1);

    const suppressed = mocks.logEventFn.mock.calls
      .map((c) => c[0])
      .find((f) => f.event === 'digest.suppressed');
    expect(suppressed.extra.reasons).toContain('duplicate');
  });

  /**
   * The guard is a per-day key, not a mute. A booking confirmed after the digest
   * went out does NOT buy a second digest today, and tomorrow's digest is a
   * different day and is not held back by today's.
   */
  it('the next business day sends again', async () => {
    const ctx = ctxFor();
    await sendScheduleDigest(NOW, DAY);
    await sendScheduleDigest(NOW + 24 * 60 * 60 * 1000, '2026-09-23');
    expect(digestWrites(ctx).length).toBe(2);
  });

  it('a day with nothing in the window sends nothing and writes nothing', async () => {
    const ctx = buildDbMock({
      docs: { [ADMINS_PATH]: { uids: ['op1'] } },
      collectionGroupDocs: { bookings: [] },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendScheduleDigest(NOW, DAY);
    expect(ctx.writes).toEqual([]);
  });
});
