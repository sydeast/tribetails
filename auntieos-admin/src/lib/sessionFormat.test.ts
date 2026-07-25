import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  sessionTimeOf,
  sessionDayKey,
  sessionClock,
  sessionWindow,
  sessionDayLabel,
  sessionHousehold,
  sessionState,
  sessionStateInfo,
  isSessionActive,
  groupSessionsByDay,
  groupSessionsByPhase,
  sessionsWindowBounds,
  localDateIso,
  type SessionSort,
} from './sessionFormat';

// File-scope TZ pin: several suites below (groupSessionsByDay, sessionDayLabel)
// assert LOCAL day keys derived from UTC strings. Without a fixed zone those
// pass on a US runner and fail east of UTC, pin the whole file to a known zone
// so the AO-18 local-day guarantee is tested meaningfully everywhere, not just
// inside the one describe that pinned it locally.
let fileOriginalTz: string | undefined;
beforeAll(() => {
  fileOriginalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (fileOriginalTz === undefined) delete process.env.TZ;
  else process.env.TZ = fileOriginalTz;
});

describe('sessionTimeOf', () => {
  it('degrades honestly on blank/unparseable input, never fabricating a date', () => {
    expect(sessionTimeOf('')).toBeNull();
    expect(sessionTimeOf('   ')).toBeNull();
    expect(sessionTimeOf('not a date')).toBeNull();
  });

  it('parses a real ISO string into a Date-backed fake Timestamp', () => {
    const wrapped = sessionTimeOf('2026-07-16T09:03:00.000Z');
    expect(wrapped).not.toBeNull();
    expect(wrapped?.toDate().getTime()).toBe(new Date('2026-07-16T09:03:00.000Z').getTime());
  });
});

describe('sessionDayKey / sessionClock (AO-18)', () => {
  it('Undated / (no time) for blank input, same fallback lib/time.ts uses for a missing Timestamp', () => {
    expect(sessionDayKey('')).toBe('Undated');
    expect(sessionClock('')).toBe('(no time)');
  });

  // This is the actual historical bug, reproduced exactly: the wasm's
  // KinCareSessionsScreen.kt groups by `session.startTime.take(10)`, the
  // first 10 characters of the raw UTC ISO string on the doc. An 8pm-CDT
  // session round-trips through `approveBookingSeriesCore.ts`'s
  // `toDate().toISOString()` as "...T01:00:00.000Z", i.e. the NEXT calendar
  // day in UTC. Naively slicing that string's first 10 characters therefore
  // reads "2026-07-17", wrong by one day. `sessionDayKey` must read
  // "2026-07-16" instead, because it parses the full instant and asks the
  // LOCAL clock what day it fell on.
  //
  // TZ is pinned to a west-of-UTC zone so the assertion is meaningful on any
  // CI runner (a UTC-default runner would otherwise make "local" and "UTC"
  // the same day, silently passing a broken implementation too). Restored in
  // afterAll so no other test file sharing this worker sees the override.
  let originalTz: string | undefined;
  beforeAll(() => {
    originalTz = process.env.TZ;
    process.env.TZ = 'America/Chicago';
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('groups an 8pm-CDT session under its LOCAL day, not the UTC-next day a raw slice would give', () => {
    const eightPmCdtAsUtc = '2026-07-17T01:00:00.000Z'; // 2026-07-16 20:00 America/Chicago (CDT, UTC-5)
    expect(sessionDayKey(eightPmCdtAsUtc)).toBe('2026-07-16');
    // The naive wasm approach this replaces, spelled out so the regression is legible:
    expect(eightPmCdtAsUtc.slice(0, 10)).toBe('2026-07-17'); // what a raw slice would wrongly say
  });

  it('shows the LOCAL clock time too, not the UTC hour (five hours off in CDT)', () => {
    expect(sessionClock('2026-07-17T01:00:00.000Z')).toBe('20:00');
  });

  it('a late-evening local time never rolls into the next LOCAL day even near a DST boundary', () => {
    // 11:30pm America/Chicago on 2026-07-16 (still CDT) as UTC.
    expect(sessionDayKey('2026-07-17T04:30:00.000Z')).toBe('2026-07-16');
  });
});

describe('sessionWindow', () => {
  it('"Time TBD" only when BOTH ends are unparseable', () => {
    expect(sessionWindow('', '')).toBe('Time TBD');
  });

  it('shows just the start when only the end is missing', () => {
    expect(sessionWindow('2026-07-16T14:00:00.000Z', '')).not.toBe('Time TBD');
  });

  it('"start to end" when both parse', () => {
    // 2026-07-16 09:00 to 10:30 UTC (no TZ pinned here, assert shape, not zone).
    const w = sessionWindow('2026-07-16T09:00:00.000Z', '2026-07-16T10:30:00.000Z');
    expect(w).toMatch(/^\d{2}:\d{2} to \d{2}:\d{2}$/);
  });
});

describe('sessionDayLabel', () => {
  it('labels the exact today/tomorrow/yesterday relative to a given local today', () => {
    expect(sessionDayLabel('2026-07-16', '2026-07-16')).toBe('Today');
    expect(sessionDayLabel('2026-07-17', '2026-07-16')).toBe('Tomorrow');
    expect(sessionDayLabel('2026-07-15', '2026-07-16')).toBe('Yesterday');
  });

  it('falls back to a weekday + month/day label further out', () => {
    expect(sessionDayLabel('2026-07-20', '2026-07-16')).toBe('Mon, Jul 20');
  });

  it('passes Undated through verbatim rather than folding it into Today', () => {
    expect(sessionDayLabel('Undated', '2026-07-16')).toBe('Undated');
  });

  /**
   * OPERATOR ISSUE #17: "add year display". A visit from last January read as
   * "Thu, Jan 16", indistinguishable from this January, which is the one thing
   * a day header must never be ambiguous about once the Archive view can reach
   * back past a year boundary.
   */
  it('shows the year when the day is not in the current year', () => {
    expect(sessionDayLabel('2025-01-16', '2026-07-16')).toBe('Thu, Jan 16, 2025');
    expect(sessionDayLabel('2027-03-02', '2026-07-16')).toBe('Tue, Mar 2, 2027');
  });

  it('omits the year in the current year, so the common case stays uncluttered', () => {
    expect(sessionDayLabel('2026-07-20', '2026-07-16')).toBe('Mon, Jul 20');
  });

  it('still says Yesterday across a New Year boundary, rather than a dated label', () => {
    // Relative labels win over the year rule: "Yesterday" is never ambiguous.
    expect(sessionDayLabel('2025-12-31', '2026-01-01')).toBe('Yesterday');
  });
});

describe('sessionHousehold', () => {
  it('falls back to "Unnamed Kinfolk" when kinfolkName is blank (the ad-hoc createKinCareSession path)', () => {
    expect(sessionHousehold('')).toBe('Unnamed Kinfolk');
    expect(sessionHousehold('   ')).toBe('Unnamed Kinfolk');
  });

  it('uses the real name when present', () => {
    expect(sessionHousehold('The Whitfields')).toBe('The Whitfields');
  });
});

describe('sessionState (positive enumeration, AO-12-style: never by negation)', () => {
  it('matches every real status code any writer sets, case-insensitively', () => {
    expect(sessionState('SCHEDULED')).toBe('scheduled');
    expect(sessionState('scheduled')).toBe('scheduled');
    expect(sessionState('ON_MY_WAY')).toBe('onMyWay');
    expect(sessionState('ARRIVED')).toBe('arrived');
    expect(sessionState('DEPARTED')).toBe('departed');
    expect(sessionState('COMPLETED')).toBe('completed');
    expect(sessionState('CANCELLED')).toBe('cancelled');
  });

  it('an unrecognized or blank status is honestly "unknown", never silently assumed scheduled', () => {
    expect(sessionState('')).toBe('unknown');
    expect(sessionState('some_future_code')).toBe('unknown');
  });

  it('every state maps to its own info, no fallback branch shared between two states', () => {
    const seen = new Set<string>();
    for (const state of ['scheduled', 'onMyWay', 'arrived', 'departed', 'completed', 'cancelled', 'unknown'] as const) {
      const info = sessionStateInfo(state);
      expect(seen.has(info.chipLabel)).toBe(false);
      seen.add(info.chipLabel);
    }
  });
});

describe('isSessionActive', () => {
  it('is true only for the three in-flight states', () => {
    expect(isSessionActive('onMyWay')).toBe(true);
    expect(isSessionActive('arrived')).toBe(true);
    expect(isSessionActive('departed')).toBe(true);
  });

  it('is false for scheduled/completed/cancelled/unknown', () => {
    expect(isSessionActive('scheduled')).toBe(false);
    expect(isSessionActive('completed')).toBe(false);
    expect(isSessionActive('cancelled')).toBe(false);
    expect(isSessionActive('unknown')).toBe(false);
  });
});

describe('groupSessionsByDay', () => {
  interface Row {
    id: string;
    startTime: string;
  }

  it('groups rows by LOCAL day and sorts each day chronologically ascending', () => {
    const rows: Row[] = [
      { id: 'late', startTime: '2026-07-16T20:00:00.000Z' },
      { id: 'early', startTime: '2026-07-16T09:00:00.000Z' },
      { id: 'nextday', startTime: '2026-07-17T09:00:00.000Z' },
    ];
    const groups = groupSessionsByDay(rows);
    expect(groups.map((g) => g.dayKeyValue)).toEqual(['2026-07-16', '2026-07-17']);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['early', 'late']);
  });

  it('Undated rows get their own group, sorted last', () => {
    const rows: Row[] = [
      { id: 'dated', startTime: '2026-07-16T09:00:00.000Z' },
      { id: 'undated', startTime: '' },
    ];
    const groups = groupSessionsByDay(rows);
    expect(groups.map((g) => g.dayKeyValue)).toEqual(['2026-07-16', 'Undated']);
  });

  it('an empty input produces no groups, never a fabricated placeholder', () => {
    expect(groupSessionsByDay([])).toEqual([]);
  });
});

describe('localDateIso re-export', () => {
  it('is the same lib/invoiceFormat helper, not a re-derived duplicate', () => {
    expect(typeof localDateIso).toBe('function');
    expect(localDateIso(new Date(2026, 6, 16))).toBe('2026-07-16');
  });
});
/**
 * OPERATOR ISSUE #17. The sub-header has always promised "Every Kin Care today
 * and coming up, plus what wrapped recently", while the screen streamed a flat
 * 300 rows ordered by startTime desc, so the data contradicted the copy. These
 * cases pin the window the copy describes.
 */
describe('groupSessionsByPhase: Active / Upcoming / Recent, and nothing else', () => {
  interface Row {
    id: string;
    startTime: string;
    status: string;
    completedAt?: string;
  }
  const TODAY = '2026-07-16';
  /** Local noon on the day [TODAY] + [offset], as a UTC instant string. */
  function dayOffset(offset: number, hour = 12): string {
    return new Date(2026, 6, 16 + offset, hour).toISOString();
  }
  const fixture: Row[] = [
    { id: 'active', startTime: dayOffset(0, 9), status: 'ARRIVED' },
    { id: 'tomorrow', startTime: dayOffset(1), status: 'SCHEDULED' },
    { id: 'threeDaysAgo', startTime: dayOffset(-3), status: 'COMPLETED', completedAt: dayOffset(-3, 14) },
    { id: 'thirtyDaysAgo', startTime: dayOffset(-30), status: 'COMPLETED', completedAt: dayOffset(-30, 14) },
  ];
  function idsByPhase(rows: Row[], today = TODAY) {
    const groups = groupSessionsByPhase(rows, today);
    return Object.fromEntries(
      groups.map((g) => [g.phase, g.days.flatMap((d) => d.rows.map((r) => r.id))]),
    );
  }
  it('puts an in-flight visit, tomorrow, and a wrap from three days ago in their own phases', () => {
    expect(idsByPhase(fixture)).toEqual({
      active: ['active'],
      upcoming: ['tomorrow'],
      recent: ['threeDaysAgo'],
    });
  });
  it('excludes a wrap from thirty days ago: Recent means the last seven days', () => {
    const all = Object.values(idsByPhase(fixture)).flat();
    expect(all).not.toContain('thirtyDaysAgo');
  });
  it('keeps a wrap exactly seven days old, and drops one eight days old (the boundary)', () => {
    const rows: Row[] = [
      { id: 'sevenDays', startTime: dayOffset(-7), status: 'COMPLETED', completedAt: dayOffset(-7, 14) },
      { id: 'eightDays', startTime: dayOffset(-8), status: 'COMPLETED', completedAt: dayOffset(-8, 14) },
    ];
    expect(idsByPhase(rows).recent).toEqual(['sevenDays']);
  });
  it('keeps an in-flight visit whatever its date, so a stale clock-in is never lost', () => {
    const rows: Row[] = [{ id: 'stuck', startTime: dayOffset(-20), status: 'ARRIVED' }];
    expect(idsByPhase(rows).active).toEqual(['stuck']);
  });
  it('dates a cancellation by its start time, since a cancelled visit has no completedAt', () => {
    const rows: Row[] = [{ id: 'called-off', startTime: dayOffset(-2), status: 'CANCELLED' }];
    expect(idsByPhase(rows).recent).toEqual(['called-off']);
  });
  it('shows a scheduled visit yesterday that never got clocked, rather than dropping it', () => {
    // The archive kept SCHEDULED visible from yesterday for exactly this reason:
    // a visit nobody started is the one an operator most needs to see.
    const rows: Row[] = [{ id: 'missed', startTime: dayOffset(-1), status: 'SCHEDULED' }];
    expect(idsByPhase(rows).upcoming).toEqual(['missed']);
  });
  it('stops at the fourteen-day upcoming horizon, so an approved series cannot bury today', () => {
    const rows: Row[] = [
      { id: 'inHorizon', startTime: dayOffset(14), status: 'SCHEDULED' },
      { id: 'pastHorizon', startTime: dayOffset(15), status: 'SCHEDULED' },
    ];
    expect(idsByPhase(rows).upcoming).toEqual(['inHorizon']);
  });
  it('hides the booking-queue states the Bookings screen owns (archive AO-60)', () => {
    const rows: Row[] = [
      { id: 'draft', startTime: dayOffset(1), status: 'DRAFT' },
      { id: 'pending', startTime: dayOffset(1), status: 'PENDING' },
      { id: 'rejected', startTime: dayOffset(1), status: 'REJECTED' },
    ];
    expect(groupSessionsByPhase(rows, TODAY)).toEqual([]);
  });
  it('surfaces an unrecognized status under Upcoming rather than swallowing it', () => {
    // AO-12: an unknown code is not silently dropped. It is not a booking-queue
    // state (those are matched positively above), so it is a visit on the books
    // and the row still carries its own UNKNOWN chip.
    const rows: Row[] = [{ id: 'novel', startTime: dayOffset(2), status: 'some_new_code' }];
    expect(idsByPhase(rows).upcoming).toEqual(['novel']);
  });
  it('emits no group at all for a phase with no rows, never an empty heading', () => {
    const rows: Row[] = [{ id: 'tomorrow', startTime: dayOffset(1), status: 'SCHEDULED' }];
    expect(groupSessionsByPhase(rows, TODAY).map((g) => g.phase)).toEqual(['upcoming']);
  });
  it('orders the phases Active, Upcoming, Recent, matching the archive', () => {
    expect(groupSessionsByPhase(fixture, TODAY).map((g) => g.phase)).toEqual([
      'active',
      'upcoming',
      'recent',
    ]);
  });
  it('keeps day sub-groups inside each phase, so headers stay per-day', () => {
    const rows: Row[] = [
      { id: 'day1a', startTime: dayOffset(1, 9), status: 'SCHEDULED' },
      { id: 'day1b', startTime: dayOffset(1, 15), status: 'SCHEDULED' },
      { id: 'day2', startTime: dayOffset(2, 9), status: 'SCHEDULED' },
    ];
    const upcoming = groupSessionsByPhase(rows, TODAY)[0]!;
    expect(upcoming.days).toHaveLength(2);
    expect(upcoming.days[0]!.rows.map((r) => r.id)).toEqual(['day1a', 'day1b']);
  });
});
describe('groupSessionsByPhase: the sort control', () => {
  interface Row {
    id: string;
    startTime: string;
    status: string;
  }
  const TODAY = '2026-07-16';
  function dayOffset(offset: number, hour = 12): string {
    return new Date(2026, 6, 16 + offset, hour).toISOString();
  }
  const rows: Row[] = [
    { id: 'day1a', startTime: dayOffset(1, 9), status: 'SCHEDULED' },
    { id: 'day1b', startTime: dayOffset(1, 15), status: 'SCHEDULED' },
    { id: 'day2', startTime: dayOffset(2, 9), status: 'SCHEDULED' },
  ];
  function flatIds(direction: SessionSort): string[] {
    return groupSessionsByPhase(rows, TODAY, direction)[0]!.days.flatMap((d) =>
      d.rows.map((r) => r.id),
    );
  }
  it('defaults to soonest first', () => {
    expect(flatIds('soonest')).toEqual(['day1a', 'day1b', 'day2']);
    expect(
      groupSessionsByPhase(rows, TODAY)[0]!.days.flatMap((d) => d.rows.map((r) => r.id)),
    ).toEqual(['day1a', 'day1b', 'day2']);
  });
  it('latest first reverses both the day groups and the rows within a day', () => {
    expect(flatIds('latest')).toEqual(['day2', 'day1b', 'day1a']);
  });
  it('reverses WITHIN a phase without reordering the phases themselves', () => {
    const mixed = [
      { id: 'upcoming', startTime: dayOffset(1), status: 'SCHEDULED' },
      { id: 'active', startTime: dayOffset(0), status: 'ARRIVED' },
    ];
    expect(groupSessionsByPhase(mixed, TODAY, 'latest').map((g) => g.phase)).toEqual([
      'active',
      'upcoming',
    ]);
  });
});
describe('sessionsWindowBounds: the bounded fetch range', () => {
  it('reaches back thirty days and forward fifteen, a deliberate backstop around the display window', () => {
    // The DISPLAY window is -7 recent / +14 upcoming. The FETCH range is wider
    // on purpose: a stale in-flight visit must still reach Active, and the extra
    // forward day absorbs the UTC-vs-local boundary, since the query compares
    // raw ISO text while grouping parses to a local day.
    expect(sessionsWindowBounds('2026-07-16')).toEqual({ from: '2026-06-16', to: '2026-07-31' });
  });
  it('rolls over a year boundary correctly', () => {
    expect(sessionsWindowBounds('2026-01-05')).toEqual({ from: '2025-12-06', to: '2026-01-20' });
  });
});
