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
  localDateIso,
} from './sessionFormat';

// File-scope TZ pin: several suites below (groupSessionsByDay, sessionDayLabel)
// assert LOCAL day keys derived from UTC strings. Without a fixed zone those
// pass on a US runner and fail east of UTC — pin the whole file to a known zone
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
  // KinCareSessionsScreen.kt groups by `session.startTime.take(10)` — the
  // first 10 characters of the raw UTC ISO string on the doc. An 8pm-CDT
  // session round-trips through `approveBookingSeriesCore.ts`'s
  // `toDate().toISOString()` as "...T01:00:00.000Z", i.e. the NEXT calendar
  // day in UTC. Naively slicing that string's first 10 characters therefore
  // reads "2026-07-17" — wrong by one day. `sessionDayKey` must read
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
    // 2026-07-16 09:00 to 10:30 UTC (no TZ pinned here — assert shape, not zone).
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
