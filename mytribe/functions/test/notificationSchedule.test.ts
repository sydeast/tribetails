import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ logEventFn: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
beforeEach(() => mocks.logEventFn.mockReset());

import {
  HOURLY_TICK,
  HOUSEHOLD_NOTIFICATION_HOUR_FIELD,
  SCHEDULED_RUNS_COLLECTION,
  SCHEDULE_DIGEST_HOUR_FIELD,
  decideTick,
  loadNotificationSchedule,
  resolveNotificationSchedule,
  resolveSendHour,
  runHourlyTick,
} from '../src/lib/notificationSchedule';

/**
 * THE OPERATOR'S HOUR.
 *
 * The operator asked that the 09:30 overdue job "shouldn't be hardcoded and
 * adjustable in the auntieos". A Cloud Scheduler expression cannot be read from
 * Firestore at runtime, so the job ticks hourly and decides. These tests hold the
 * two halves of that: the hour the operator picked is the hour it sends, and
 * moving the hour never sends twice in one day.
 *
 * THE DOUBLE-SEND TESTS ARE THE POINT OF THIS FILE. They drive a whole simulated
 * day, tick by tick, with the setting changing under the job at 11:00, in both
 * directions. Each one was watched fail against a tick that compares the hour and
 * keeps no marker, which is the version that looks right and sends twice.
 */

const SETTINGS_PATH = 'business_settings/business_settings';
const LEGACY_SETTINGS_PATH = 'business_settings/singleton';
const JOB = 'invoiceOverdueCron';
const MARKER_PATH = `${SCHEDULED_RUNS_COLLECTION}/${JOB}`;

/** Chicago runs at UTC-5 on 2026-09-22, so a Chicago hour is that hour plus five. */
const ZONE = 'America/Chicago';
const DAY = '2026-09-22';
const at = (chicagoHour: number): number => Date.UTC(2026, 8, 22, chicagoHour + 5, 0, 0);
const nextDayAt = (chicagoHour: number): number => Date.UTC(2026, 8, 23, chicagoHour + 5, 0, 0);

const logFor = (event: string) =>
  mocks.logEventFn.mock.calls.map((c) => c[0]).find((f) => f.event === event);

describe('the cron expression', () => {
  /**
   * `every 60 minutes` promises a sixty-minute gap and not the top of the hour,
   * and a job that drifts to :47 asks "is it 09:00 yet" at a different point in
   * the hour every day. The zone is UTC because an hourly cron in a DST zone has
   * to answer for the spring hour that does not exist and the autumn hour that
   * happens twice.
   */
  it('is unix cron on the hour, in UTC', () => {
    expect(HOURLY_TICK).toEqual({ schedule: '0 * * * *', timeZone: 'Etc/UTC' });
  });
});

describe('resolveSendHour: what the settings document is allowed to say', () => {
  it('takes an integer 0..23 and reports it as stored', () => {
    expect(resolveSendHour(0)).toEqual({ hour: 0, source: 'stored' });
    expect(resolveSendHour(14)).toEqual({ hour: 14, source: 'stored' });
    expect(resolveSendHour(23)).toEqual({ hour: 23, source: 'stored' });
  });

  /**
   * OPERATOR RULING 2026-09-22: no job runs until they switch it on from the
   * AuntieOS UI, and the cadence is theirs to choose then. So an absent field is
   * not 09:00. It is no cadence at all, and there is no constant to import.
   */
  it('absent is NOT a default hour, it is no cadence', () => {
    expect(resolveSendHour(undefined)).toEqual({ hour: null, source: 'unset' });
    expect(resolveSendHour(null)).toEqual({ hour: null, source: 'unset' });
  });

  /**
   * The same posture as Phase 1's gate one field away, which reads `=== true`
   * and takes every near miss as off. There is no default to rescue a bad value
   * into, and inventing one would be exactly the guess the ruling forbids.
   */
  it('a value it cannot read is no cadence either, and is flagged for the log', () => {
    for (const bad of ['9', 9.5, -1, 24, true, {}, [], NaN, Infinity]) {
      expect(resolveSendHour(bad), `${String(bad)} is not an hour`).toEqual({
        hour: null,
        source: 'unusable',
      });
    }
  });
});

describe('resolveNotificationSchedule', () => {
  it('reads both hours off the one document, with their own defaults', () => {
    expect(
      resolveNotificationSchedule({
        timeZone: ZONE,
        [HOUSEHOLD_NOTIFICATION_HOUR_FIELD]: 14,
        [SCHEDULE_DIGEST_HOUR_FIELD]: 5,
      }),
    ).toEqual({
      timeZone: ZONE,
      householdHour: { hour: 14, source: 'stored' },
      digestHour: { hour: 5, source: 'stored' },
    });
  });

  /**
   * THE STATE THIS SHIPS IN. Not one production settings document carries either
   * field, so on the day this deploys every hour-driven job is inert and stays
   * inert until the operator picks an hour.
   */
  it('an empty document schedules nothing at all', () => {
    const s = resolveNotificationSchedule({});
    expect(s.householdHour).toEqual({ hour: null, source: 'unset' });
    expect(s.digestHour).toEqual({ hour: null, source: 'unset' });
  });

  it('a blank or unparseable zone falls back to the ruled America/Chicago', () => {
    expect(resolveNotificationSchedule(null).timeZone).toBe('America/Chicago');
    expect(resolveNotificationSchedule({ timeZone: '  ' }).timeZone).toBe('America/Chicago');
    expect(resolveNotificationSchedule({ timeZone: 'Mars/Olympus' }).timeZone).toBe('America/Chicago');
    expect(resolveNotificationSchedule({ timeZone: 42 }).timeZone).toBe('America/Chicago');
  });

  /** The stored zone still wins, so a relocation stays a settings change. */
  it('a usable stored zone wins over the fallback', () => {
    expect(resolveNotificationSchedule({ timeZone: 'Europe/Lisbon' }).timeZone).toBe('Europe/Lisbon');
  });
});

describe('decideTick', () => {
  it('waits while the business clock is before the hour', () => {
    for (const h of [0, 5, 8]) {
      expect(decideTick({ nowMs: at(h), timeZone: ZONE, hour: 9, lastRunDayIso: null })).toEqual({
        verdict: 'before-hour',
        dayIso: DAY,
        localHour: h,
      });
    }
  });

  it('runs on the hour, and on every hour after it while the day is unmarked', () => {
    for (const h of [9, 10, 23]) {
      expect(decideTick({ nowMs: at(h), timeZone: ZONE, hour: 9, lastRunDayIso: null }).verdict).toBe(
        'run',
      );
    }
  });

  /**
   * THE CATCH-UP RULE. `>=` rather than `==` because a tick that does not happen
   * is otherwise a day that does not happen: Cloud Scheduler can miss a fire and
   * a deploy can land on the hour, and under exact match the job then waits a
   * full day.
   */
  it('catches up after a missed tick instead of losing the day', () => {
    // 09:00 never fired. 10:00 does the work.
    expect(decideTick({ nowMs: at(10), timeZone: ZONE, hour: 9, lastRunDayIso: null }).verdict).toBe(
      'run',
    );
  });

  it('stops on the marker, whatever the hour says', () => {
    for (const h of [9, 12, 23]) {
      expect(decideTick({ nowMs: at(h), timeZone: ZONE, hour: 9, lastRunDayIso: DAY }).verdict).toBe(
        'already-ran-today',
      );
    }
  });

  it('yesterday in the marker is not today, so a new day runs', () => {
    expect(
      decideTick({ nowMs: nextDayAt(9), timeZone: ZONE, hour: 9, lastRunDayIso: DAY }).verdict,
    ).toBe('run');
  });

  /**
   * The day is the BUSINESS day, never the UTC day. At 23:00 Chicago it is
   * already tomorrow in UTC, and a UTC marker would let a late hour fire twice.
   */
  it('names the business day, not the UTC day', () => {
    const lateEvening = decideTick({ nowMs: at(23), timeZone: ZONE, hour: 22, lastRunDayIso: null });
    expect(new Date(at(23)).toISOString().slice(0, 10), 'UTC has already rolled over').toBe(
      '2026-09-23',
    );
    expect(lateEvening.dayIso).toBe(DAY);
  });

  it('reports a clock it cannot read rather than guessing one', () => {
    expect(
      decideTick({ nowMs: Number.NaN, timeZone: ZONE, hour: 9, lastRunDayIso: null }),
    ).toEqual({ verdict: 'clock-unresolved', dayIso: '', localHour: -1 });
  });
});

describe('loadNotificationSchedule', () => {
  it('reads the modern document, and falls back to the legacy singleton', async () => {
    const modern = buildDbMock({ docs: { [SETTINGS_PATH]: { [HOUSEHOLD_NOTIFICATION_HOUR_FIELD]: 6 } } });
    const a = await loadNotificationSchedule(modern.db, JOB);
    expect(a.ok && a.schedule.householdHour.hour).toBe(6);

    const legacy = buildDbMock({
      docs: { [SETTINGS_PATH]: null, [LEGACY_SETTINGS_PATH]: { [HOUSEHOLD_NOTIFICATION_HOUR_FIELD]: 6 } },
    });
    const b = await loadNotificationSchedule(legacy.db, JOB);
    expect(b.ok && b.schedule.householdHour.hour).toBe(6);
  });

  it('no settings document at all schedules nothing, and logs nothing', async () => {
    const ctx = buildDbMock({ docs: { [SETTINGS_PATH]: null } });
    const read = await loadNotificationSchedule(ctx.db, JOB);
    expect(read.ok && read.schedule.householdHour).toEqual({ hour: null, source: 'unset' });
    expect(mocks.logEventFn).not.toHaveBeenCalled();
  });

  /**
   * FAIL CLOSED, as Phase 1's gate does. The trade is easier here: under a daily
   * cron an unreadable settings document cost a whole day of notices, and under
   * an hourly tick it costs one hour.
   */
  it('a read that throws is not an hour, and says so at critical', async () => {
    const ctx = buildDbMock({ docs: { [SETTINGS_PATH]: null } });
    ctx.db.doc(SETTINGS_PATH).get = vi.fn().mockRejectedValue(new Error('DEADLINE_EXCEEDED'));

    const read = await loadNotificationSchedule(ctx.db, JOB);
    expect(read).toEqual({ ok: false, reason: 'read-failed' });

    const logged = logFor('notification.schedule.read.failed');
    expect(logged.severity).toBe('critical');
    expect(logged.errorMessage).toContain('DEADLINE_EXCEEDED');
  });
});

/** Drives one tick and reports whether the scan ran. */
async function tick(
  ctx: ReturnType<typeof buildDbMock>,
  nowMs: number,
  ran: string[],
): Promise<string> {
  const result = await runHourlyTick({
    firestore: ctx.db,
    functionName: JOB,
    nowMs,
    pickHour: (s) => s.householdHour,
    scan: async (dayIso) => {
      ran.push(dayIso);
    },
  });
  return result.verdict;
}

describe('runHourlyTick: the shape of one tick', () => {
  it('runs the scan on the hour and records the business day it finished', async () => {
    const ctx = buildDbMock({
      docs: { [SETTINGS_PATH]: { timeZone: ZONE, [HOUSEHOLD_NOTIFICATION_HOUR_FIELD]: 9 } },
      writeThrough: true,
    });
    const ran: string[] = [];
    expect(await tick(ctx, at(9), ran)).toBe('run');
    expect(ran).toEqual([DAY]);
    expect(ctx.writes.filter((w) => w.path === MARKER_PATH)).toEqual([
      { path: MARKER_PATH, data: { lastRunDayIso: DAY, lastRunAtMs: at(9), hour: 9, timeZone: ZONE }, merge: true, options: { merge: true } },
    ]);
  });

  /**
   * THE COST CLAIM, asserted rather than described. A daily job going hourly is
   * 23 extra invocations a day, and the whole reason that is affordable is that a
   * tick before the hour reads ONE document and stops: it never reads the marker
   * and never reaches the collection drain.
   */
  it('a tick before the hour costs one read, touches no marker and runs no scan', async () => {
    const ctx = buildDbMock({
      docs: { [SETTINGS_PATH]: { timeZone: ZONE, [HOUSEHOLD_NOTIFICATION_HOUR_FIELD]: 9 } },
    });
    const markerGet = ctx.db.doc(MARKER_PATH).get as ReturnType<typeof vi.fn>;
    const settingsGet = ctx.db.doc(SETTINGS_PATH).get as ReturnType<typeof vi.fn>;
    markerGet.mockClear();
    settingsGet.mockClear();

    const ran: string[] = [];
    expect(await tick(ctx, at(8), ran)).toBe('before-hour');

    expect(ran, 'no scan').toEqual([]);
    expect(markerGet, 'the marker is not read before the hour').not.toHaveBeenCalled();
    expect(settingsGet.mock.calls.length, 'one settings read and nothing else').toBe(1);
    expect(ctx.writes, 'nothing written').toEqual([]);
  });

  it('a settings read that throws skips the tick entirely', async () => {
    const ctx = buildDbMock({ docs: { [SETTINGS_PATH]: { timeZone: ZONE } } });
    ctx.db.doc(SETTINGS_PATH).get = vi.fn().mockRejectedValue(new Error('UNAVAILABLE'));

    const ran: string[] = [];
    expect(await tick(ctx, at(9), ran)).toBe('read-failed');
    expect(ran).toEqual([]);
    expect(ctx.writes).toEqual([]);
    expect(logFor('notification.schedule.read.failed').severity).toBe('critical');
  });

  /**
   * THE STATE THIS SHIPS IN, asserted against the ruling rather than described.
   * No hour means no scan at any hour of any day, whatever `invoices` holds.
   */
  it('with no hour set, no tick of the whole day does anything', async () => {
    const ctx = buildDbMock({ docs: { [SETTINGS_PATH]: { timeZone: ZONE } }, writeThrough: true });
    const markerGet = ctx.db.doc(MARKER_PATH).get as ReturnType<typeof vi.fn>;
    markerGet.mockClear();

    const ran: string[] = [];
    for (let h = 0; h <= 23; h += 1) {
      expect(await tick(ctx, at(h), ran)).toBe('not-scheduled');
    }
    expect(ran, 'not one scan').toEqual([]);
    expect(ctx.writes, 'and no write, so no marker either').toEqual([]);
    expect(markerGet, 'and the marker is never even read').not.toHaveBeenCalled();
    expect(
      mocks.logEventFn,
      'and the log is not filled with 24 lines saying an unused feature is off',
    ).not.toHaveBeenCalled();
  });

  it('an hour it cannot read warns and schedules nothing', async () => {
    const ctx = buildDbMock({
      docs: { [SETTINGS_PATH]: { timeZone: ZONE, [HOUSEHOLD_NOTIFICATION_HOUR_FIELD]: '9' } },
      writeThrough: true,
    });
    const ran: string[] = [];
    for (const h of [8, 9, 23]) {
      expect(await tick(ctx, at(h), ran)).toBe('not-scheduled');
    }
    expect(ran).toEqual([]);
    expect(logFor('notification.schedule.hour.unusable').severity).toBe('warn');
  });

  /**
   * An unreadable MARKER is not an unreadable settings document, and the two get
   * opposite answers on purpose. Not knowing what the operator asked for means we
   * cannot act. Not knowing whether we already acted means we act again and let
   * the per-record stamps referee it, which costs a wasted scan rather than a
   * second notice.
   */
  it('a marker that cannot be read lets the scan run, and warns', async () => {
    const ctx = buildDbMock({
      docs: { [SETTINGS_PATH]: { timeZone: ZONE, [HOUSEHOLD_NOTIFICATION_HOUR_FIELD]: 9 } },
    });
    ctx.db.doc(MARKER_PATH).get = vi.fn().mockRejectedValue(new Error('UNAVAILABLE'));

    const ran: string[] = [];
    expect(await tick(ctx, at(9), ran)).toBe('run');
    expect(ran).toEqual([DAY]);
    expect(logFor('notification.schedule.marker.read.failed').severity).toBe('warn');
  });

  /**
   * THE MARKER IS WRITTEN AFTER THE SCAN. A crash mid-scan then leaves the day
   * unmarked and the next tick redoes it, which every job here survives on its
   * per-record stamps. Marking first would lose a whole day to any crash.
   */
  it('a scan that throws leaves the day unmarked', async () => {
    const ctx = buildDbMock({
      docs: { [SETTINGS_PATH]: { timeZone: ZONE, [HOUSEHOLD_NOTIFICATION_HOUR_FIELD]: 9 } },
      writeThrough: true,
    });
    await expect(
      runHourlyTick({
        firestore: ctx.db,
        functionName: JOB,
        nowMs: at(9),
        pickHour: (s) => s.householdHour,
        scan: async () => {
          throw new Error('pagination died');
        },
      }),
    ).rejects.toThrow('pagination died');
    expect(ctx.writes.filter((w) => w.path === MARKER_PATH)).toEqual([]);

    // And the next tick therefore retries.
    const ran: string[] = [];
    expect(await tick(ctx, at(10), ran)).toBe('run');
    expect(ran).toEqual([DAY]);
  });

  /**
   * The scan already happened and its sends already landed, so a failed marker
   * write must not fail the function: that would only retry work that is done.
   * The cost is one extra scan on the next tick, which the per-record stamps
   * absorb.
   */
  it('a marker write that fails is logged, not thrown', async () => {
    const ctx = buildDbMock({
      docs: { [SETTINGS_PATH]: { timeZone: ZONE, [HOUSEHOLD_NOTIFICATION_HOUR_FIELD]: 9 } },
    });
    ctx.db.doc(MARKER_PATH).set = vi.fn().mockRejectedValue(new Error('ABORTED'));

    const ran: string[] = [];
    expect(await tick(ctx, at(9), ran)).toBe('run');
    expect(ran).toEqual([DAY]);
    expect(logFor('notification.schedule.marker.write.failed').severity).toBe('error');
  });
});

/**
 * THE DOUBLE-SEND GUARD, DRIVEN AS A WHOLE DAY.
 *
 * `change` is applied to the settings document at 11:00, mid-day, exactly as an
 * operator would. Every one of the 24 ticks is then driven in order against one
 * write-through mock, so the marker each tick writes is the marker the next tick
 * reads.
 */
async function runDay(opts: {
  startHour: number;
  changeToHour?: number;
  changeAtHour?: number;
  markerDay?: string;
  now?: (h: number) => number;
}): Promise<number[]> {
  const clock = opts.now ?? at;
  const docs: Record<string, Record<string, unknown> | null> = {
    [SETTINGS_PATH]: { timeZone: ZONE, [HOUSEHOLD_NOTIFICATION_HOUR_FIELD]: opts.startHour },
  };
  if (opts.markerDay !== undefined) docs[MARKER_PATH] = { lastRunDayIso: opts.markerDay };
  const ctx = buildDbMock({ docs, writeThrough: true });

  const scanned: number[] = [];
  for (let h = 0; h <= 23; h += 1) {
    if (opts.changeToHour !== undefined && h === opts.changeAtHour) {
      docs[SETTINGS_PATH] = { timeZone: ZONE, [HOUSEHOLD_NOTIFICATION_HOUR_FIELD]: opts.changeToHour };
    }
    const ran: string[] = [];
    await tick(ctx, clock(h), ran);
    if (ran.length > 0) scanned.push(h);
  }
  return scanned;
}

describe('the double-send guard, across a whole day', () => {
  it('an undisturbed day scans exactly once, on the hour', async () => {
    expect(await runDay({ startHour: 9 })).toEqual([9]);
  });

  /**
   * The operator moves the hour EARLIER, past a time that has already gone by.
   * The reasonable reading of that at 11am is "send them now", and the catch-up
   * rule obliges. What it must not do is then keep obliging every hour after.
   */
  it('14 to 09 at 11:00 sends once, at 11:00, and not again', async () => {
    expect(await runDay({ startHour: 14, changeToHour: 9, changeAtHour: 11 })).toEqual([11]);
  });

  /**
   * The operator moves the hour LATER, after the old hour has already sent. This
   * is the row an exact-hour comparison gets wrong: 09:00 has happened and 14:00
   * is still to come, so a tick with no marker fires on both.
   */
  it('09 to 14 at 11:00 does NOT send a second time', async () => {
    expect(await runDay({ startHour: 9, changeToHour: 14, changeAtHour: 11 })).toEqual([9]);
  });

  it('09 to 08 at 11:00 does not send a second time either', async () => {
    expect(await runDay({ startHour: 9, changeToHour: 8, changeAtHour: 11 })).toEqual([9]);
  });

  it('14 to 15 at 11:00 sends once, an hour later than yesterday', async () => {
    expect(await runDay({ startHour: 14, changeToHour: 15, changeAtHour: 11 })).toEqual([15]);
  });

  it("a marker left from yesterday does not hold today's scan back", async () => {
    expect(await runDay({ startHour: 9, markerDay: '2026-09-21' })).toEqual([9]);
  });

  it("today's marker holds every tick of today, including the hour itself", async () => {
    expect(await runDay({ startHour: 9, markerDay: DAY })).toEqual([]);
  });

  /** Hour 0 is a legal choice and must not read as "no hour set". */
  it('midnight is an hour like any other', async () => {
    expect(await runDay({ startHour: 0 })).toEqual([0]);
  });

  /** Hour 23 leaves one tick to catch it, and the marker still has to be right. */
  it('23:00 sends on the last tick of the business day', async () => {
    expect(await runDay({ startHour: 23 })).toEqual([23]);
  });

  /**
   * The day that runs 23 hours. Chicago springs forward on 2027-03-14, so the
   * local hour 02 never occurs. An hour set to 2 would never match under `==`;
   * under `>=` the 03:00 tick catches it, once.
   */
  it('the spring-forward hour that does not exist is caught once, not lost and not twice', async () => {
    const springAt = (h: number): number => Date.UTC(2027, 2, 14, h + 6, 0, 0);
    const scanned = await runDay({ startHour: 2, now: springAt });
    expect(scanned.length, 'exactly one scan on the short day').toBe(1);
  });
});
