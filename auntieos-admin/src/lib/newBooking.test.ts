import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  localDayTimeToMs,
  expandWeekly,
  visitMsFromDays,
  sortedDays,
  allInFuture,
  serviceDurationMinutes,
  sortServiceTypesByDuration,
  serviceOptionsFromRates,
  storedDurationMinutes,
  serviceChipLabel,
} from './newBooking';

// AO-18: this math is LOCAL-time; pin the zone so the assertions are stable.
const ORIG_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  process.env.TZ = ORIG_TZ;
});

describe('localDayTimeToMs', () => {
  it('combines a calendar day and a wall-clock time as LOCAL, never UTC', () => {
    const ms = localDayTimeToMs('2026-08-03', '09:00');
    expect(ms).not.toBeNull();
    const d = new Date(ms!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // August, 0-based
    expect(d.getDate()).toBe(3);
    expect(d.getHours()).toBe(9);
    // The zone is pinned to America/Chicago above, so the local reading and the
    // UTC reading must actually differ. Without this the test would pass just as
    // well against a UTC-parsing implementation, which is the AO-18 bug.
    expect(new Date(ms!).getUTCHours()).not.toBe(9);
  });
  it('returns null for a blank or garbage half', () => {
    expect(localDayTimeToMs('', '09:00')).toBeNull();
    expect(localDayTimeToMs('2026-08-03', '')).toBeNull();
    expect(localDayTimeToMs('   ', '   ')).toBeNull();
    expect(localDayTimeToMs('not-a-date', '09:00')).toBeNull();
    expect(localDayTimeToMs('2026-08-03', 'noon')).toBeNull();
  });
});

describe('expandWeekly', () => {
  it('produces one occurrence per selected weekday per week, each on the right weekday', () => {
    // 2026-08-03 is a Monday. Ask for Mon(1) + Wed(3), 2 weeks.
    const ms = expandWeekly({ startDateIso: '2026-08-03', time: '09:00', weeklyDays: [1, 3], weeks: 2 });
    expect(ms).toHaveLength(4);
    for (const m of ms) {
      const d = new Date(m);
      expect([1, 3]).toContain(d.getDay());
      expect(d.getHours()).toBe(9);
    }
    // ascending
    expect([...ms].sort((a, b) => a - b)).toEqual(ms);
  });
  it('is empty when no weekday is selected or weeks < 1', () => {
    expect(expandWeekly({ startDateIso: '2026-08-03', time: '09:00', weeklyDays: [], weeks: 2 })).toEqual([]);
    expect(expandWeekly({ startDateIso: '2026-08-03', time: '09:00', weeklyDays: [1], weeks: 0 })).toEqual([]);
  });
  it('is empty for a blank date or time', () => {
    expect(expandWeekly({ startDateIso: '', time: '09:00', weeklyDays: [1], weeks: 1 })).toEqual([]);
    expect(expandWeekly({ startDateIso: '2026-08-03', time: '', weeklyDays: [1], weeks: 1 })).toEqual([]);
  });
});

describe('visitMsFromDays', () => {
  it('applies the one shared time to every picked day, ascending', () => {
    const ms = visitMsFromDays(['2026-08-10', '2026-08-03'], '14:30');
    expect(ms).toHaveLength(2);
    expect(ms[0]).toBeLessThan(ms[1]!);
    for (const m of ms) {
      const d = new Date(m);
      expect(d.getHours()).toBe(14);
      expect(d.getMinutes()).toBe(30);
    }
  });
  it('takes a Set straight from the calendar and drops unparseable days', () => {
    const ms = visitMsFromDays(new Set(['2026-08-10', '', 'not-a-day', '2026-08-03']), '09:00');
    expect(ms).toHaveLength(2);
  });
  it('is empty when the time is blank, since no day has an instant without one', () => {
    expect(visitMsFromDays(['2026-08-03'], '')).toEqual([]);
  });
});

describe('sortedDays', () => {
  it('orders local YYYY-MM-DD days ascending, whatever order the Set iterates in', () => {
    expect(sortedDays(new Set(['2026-09-01', '2026-08-31', '2026-08-03']))).toEqual([
      '2026-08-03',
      '2026-08-31',
      '2026-09-01',
    ]);
  });
});

describe('allInFuture', () => {
  it('is true when every start is at/after now (minus a 1-min grace)', () => {
    const now = 1_000_000_000_000;
    expect(allInFuture([now + 1000, now + 5000], now)).toBe(true);
    expect(allInFuture([now - 30_000], now)).toBe(true); // within grace
  });
  it('is false when any start is safely in the past', () => {
    const now = 1_000_000_000_000;
    expect(allInFuture([now + 5000, now - 120_000], now)).toBe(false);
  });
});

describe('serviceDurationMinutes', () => {
  it('reads minutes and hours out of the name, hours converted', () => {
    expect(serviceDurationMinutes('30Minute')).toBe(30);
    expect(serviceDurationMinutes('45 min')).toBe(45);
    expect(serviceDurationMinutes('1Hr')).toBe(60);
    expect(serviceDurationMinutes('2Hours')).toBe(120);
  });
  it('takes the LARGEST match when a name states more than one', () => {
    // The archive's rule: "Half-Day 6Hrs" is 360, not 0 and not the first match.
    expect(serviceDurationMinutes('Half-Day 6Hrs')).toBe(360);
  });
  it('is null when the name states no duration at all', () => {
    expect(serviceDurationMinutes('Consultation')).toBeNull();
    expect(serviceDurationMinutes('Meet & Greet')).toBeNull();
    expect(serviceDurationMinutes('')).toBeNull();
  });
});

describe('sortServiceTypesByDuration', () => {
  it("orders the operator's real types shortest-first", () => {
    // Same fixture the archive ServiceTypeSortTest pins.
    const input = ['60Minute', 'Half-Day 6Hrs', '90Minute', '45Minute', '30Minute', '2Hrs'];
    expect(sortServiceTypesByDuration(input)).toEqual([
      '30Minute',
      '45Minute',
      '60Minute',
      '90Minute',
      '2Hrs',
      'Half-Day 6Hrs',
    ]);
  });
  it('hours beat minutes', () => {
    expect(sortServiceTypesByDuration(['2Hours', '1Hr', '45Minute'])).toEqual([
      '45Minute',
      '1Hr',
      '2Hours',
    ]);
  });
  it('unparseable durations sort last but keep their relative order', () => {
    expect(sortServiceTypesByDuration(['Consultation', '30Minute', 'Meet & Greet'])).toEqual([
      '30Minute',
      'Consultation',
      'Meet & Greet',
    ]);
  });
  it('is stable for equal durations, and does not mutate the input', () => {
    const input = ['60 Minute walk', '1Hr sit', '60Minute'];
    expect(sortServiceTypesByDuration(input)).toEqual(['60 Minute walk', '1Hr sit', '60Minute']);
    expect(input).toEqual(['60 Minute walk', '1Hr sit', '60Minute']);
  });
  it('handles an empty list', () => {
    expect(sortServiceTypesByDuration([])).toEqual([]);
  });
});

describe('serviceOptionsFromRates', () => {
  it('turns the serviceRates map into duration-ordered options, rate verbatim', () => {
    expect(
      serviceOptionsFromRates({ '2Hrs': '60', '30Minute': '25', Consultation: '0', '45Minute': '35.50' }),
    ).toEqual([
      { name: '30Minute', rate: '25', durationMinutes: 30 },
      { name: '45Minute', rate: '35.50', durationMinutes: 45 },
      { name: '2Hrs', rate: '60', durationMinutes: 120 },
      { name: 'Consultation', rate: '0', durationMinutes: null },
    ]);
  });
  it('keeps a service whose rate is not set yet (the editor allows a blank rate)', () => {
    expect(serviceOptionsFromRates({ Overnight: '' })).toEqual([
      { name: 'Overnight', rate: '', durationMinutes: null },
    ]);
  });
  it('drops blank keys and trims, and survives a junk (non-string) rate', () => {
    const raw = { '  ': '10', '  30Minute  ': ' 25 ', Walk: 7 } as unknown as Record<string, string>;
    expect(serviceOptionsFromRates(raw)).toEqual([
      { name: '30Minute', rate: '25', durationMinutes: 30 },
      { name: 'Walk', rate: '', durationMinutes: null },
    ]);
  });
  it('is empty for an empty map', () => {
    expect(serviceOptionsFromRates({})).toEqual([]);
  });
});

/**
 * Mark 15 of the 2026-08-17 admin walk gave KinCare a real duration attribute.
 * `business_settings.serviceDurations` is sparse and nothing backfills it, so
 * most of what matters here is the fallback still working for every type that
 * predates it. Mirrored in Android's ServiceTypeSortTest.
 */
describe('storedDurationMinutes', () => {
  it('reads a stated number of minutes', () => {
    expect(storedDurationMinutes('45')).toBe(45);
    expect(storedDurationMinutes(' 720 ')).toBe(720);
  });
  it('returns null on anything unusable, so the name parse gets its turn', () => {
    // Null and not 0: a mistyped duration must not declare a visit instant.
    expect(storedDurationMinutes('abc')).toBeNull();
    expect(storedDurationMinutes('0')).toBeNull();
    expect(storedDurationMinutes('-5')).toBeNull();
    expect(storedDurationMinutes('')).toBeNull();
    expect(storedDurationMinutes(undefined)).toBeNull();
    expect(storedDurationMinutes(45)).toBeNull();
  });
});
describe('serviceOptionsFromRates with stored durations', () => {
  it('prefers the stored duration over the one in the name', () => {
    const [option] = serviceOptionsFromRates({ '30Minute': '25' }, { '30Minute': '45' });
    expect(option?.durationMinutes).toBe(45);
  });
  it('falls back to the name when the type has no stored duration', () => {
    const [option] = serviceOptionsFromRates({ '30Minute': '25' }, {});
    expect(option?.durationMinutes).toBe(30);
  });
  it('gives a length to a name that states none', () => {
    const [option] = serviceOptionsFromRates({ Consultation: '0' }, { Consultation: '20' });
    expect(option?.durationMinutes).toBe(20);
  });
  it('falls through to the name when the stored value is junk', () => {
    const [option] = serviceOptionsFromRates({ '30Minute': '25' }, { '30Minute': 'oops' });
    expect(option?.durationMinutes).toBe(30);
  });
  it('reorders the options: a stated length moves a name that states nothing', () => {
    // Overnight states no length in its name, so it used to sort last with
    // everything else that states none. Stated at 45 minutes it sorts FIRST,
    // ahead of 2Hrs, which the name parse alone could never produce.
    const options = serviceOptionsFromRates(
      { Overnight: '80', '2Hrs': '60', Consultation: '' },
      { Overnight: '45' },
    );
    expect(options.map((o) => o.name)).toEqual(['Overnight', '2Hrs', 'Consultation']);
  });
  it('is unchanged when no durations map is passed at all', () => {
    expect(serviceOptionsFromRates({ '2Hrs': '60', '30Minute': '25' }).map((o) => o.name)).toEqual([
      '30Minute',
      '2Hrs',
    ]);
  });
});
describe('serviceChipLabel', () => {
  it('reads "{name} · ${rate}"', () => {
    expect(serviceChipLabel({ name: '30Minute', rate: '25', durationMinutes: 30 })).toBe('30Minute · $25');
  });
  it('drops the price when no rate is set, rather than showing "$"', () => {
    expect(serviceChipLabel({ name: 'Overnight', rate: '', durationMinutes: null })).toBe('Overnight');
  });
});
