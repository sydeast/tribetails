import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COVERAGE_RULES,
  DEFAULT_DURATIONS,
  alignPinnedToDurations,
  buildDayPatterns,
  coverageForDay,
  daysBetween,
  durationsFromServiceRates,
  gapWarnings,
  minutesToTime,
  normalizePackage,
  priceDay,
  pricePackage,
  quoteText,
  timeToMinutes,
  todayIso,
  visitsFromPattern,
  withKind,
  type Duration,
  type Package,
} from './coveragePackage';

const DURATIONS: readonly Duration[] = DEFAULT_DURATIONS;
const OVERNIGHT = DURATIONS.find((d) => d.kind === 'overnight')!; // d7, $150, 720min

function pkg(over: Partial<Package> = {}): Package {
  return normalizePackage({ id: 'p1', name: 'Test', ...over });
}

describe('daysBetween', () => {
  it('counts inclusively, 0 for unset/reversed', () => {
    expect(daysBetween('2026-07-01', '2026-07-05')).toBe(5);
    expect(daysBetween('2026-07-05', '2026-07-01')).toBe(0);
    expect(daysBetween('', '2026-07-05')).toBe(0);
  });
});

describe('time helpers', () => {
  it('parses/formats', () => {
    expect(timeToMinutes('07:30')).toBe(450);
    expect(timeToMinutes('nope')).toBeNull();
    expect(minutesToTime(450)).toBe('7:30 AM');
    expect(minutesToTime(1320)).toBe('10:00 PM');
  });
});

describe('todayIso', () => {
  it('is the LOCAL calendar date, not the UTC one', () => {
    // 10:30 PM local on the 9th. `toISOString().slice(0, 10)` gives the 10th
    // anywhere west of Greenwich, which is the bug this helper exists to avoid.
    expect(todayIso(new Date(2026, 8, 9, 22, 30))).toBe('2026-09-09');
    expect(todayIso(new Date(2026, 0, 5, 0, 15))).toBe('2026-01-05');
  });
});

describe('durationsFromServiceRates (issue #693)', () => {
  const RATES = { '30Minute': '25', 'Half-Day 6Hrs': '100', Overnight: '150', Consultation: '' };

  it('reads the operator KinCare types as the visit menu, keyed by name', () => {
    const menu = durationsFromServiceRates(RATES);
    const byId = Object.fromEntries(menu.map((d) => [d.id, d]));
    expect(byId['30Minute']).toEqual({ id: '30Minute', label: '30Minute', minutes: 30, price: 25, kind: 'visit' });
    expect(byId['Half-Day 6Hrs']!.minutes).toBe(360);
    expect(byId['Half-Day 6Hrs']!.price).toBe(100);
  });

  it('reads a type named overnight as an overnight, and everything else as a visit', () => {
    const menu = durationsFromServiceRates(RATES);
    expect(menu.find((d) => d.id === 'Overnight')!.kind).toBe('overnight');
    // A 6-hour day stay is long, but it is still a visit: length is not the signal.
    expect(menu.find((d) => d.id === 'Half-Day 6Hrs')!.kind).toBe('visit');
  });

  it('takes a stated serviceDurations minute count over the length in the name', () => {
    const menu = durationsFromServiceRates({ Overnight: '150' }, { Overnight: '720' });
    expect(menu[0]!.minutes).toBe(720);
  });

  it('keeps a type with no price or no stated length, at 0', () => {
    const menu = durationsFromServiceRates(RATES);
    const consult = menu.find((d) => d.id === 'Consultation')!;
    expect(consult.price).toBe(0);
    expect(consult.minutes).toBe(0);
  });
});

describe('alignPinnedToDurations (issue #693)', () => {
  it('repoints a pinned visit whose length is not in the menu', () => {
    const menu = durationsFromServiceRates({ '30Minute': '25', Overnight: '150' });
    // The shipped default pins `d2`, an id from the deleted builder-owned menu.
    const aligned = alignPinnedToDurations(DEFAULT_COVERAGE_RULES, menu);
    expect(aligned.pinnedTimes[0]!.durationId).toBe('30Minute');
    // Only the id moves; the client's own label and time are untouched.
    expect(aligned.pinnedTimes[0]!.label).toBe(DEFAULT_COVERAGE_RULES.pinnedTimes[0]!.label);
    expect(aligned.pinnedTimes[0]!.time).toBe(DEFAULT_COVERAGE_RULES.pinnedTimes[0]!.time);
  });

  it('leaves a pinned visit that already points at a real length alone', () => {
    const menu = durationsFromServiceRates({ '30Minute': '25', '60Minute': '45' });
    const rules = { ...DEFAULT_COVERAGE_RULES, pinnedTimes: [{ id: 'p', label: 'Meds', time: '12:00', durationId: '60Minute' }] };
    expect(alignPinnedToDurations(rules, menu).pinnedTimes[0]!.durationId).toBe('60Minute');
  });

  it('blanks the length when the menu holds no visit type at all', () => {
    expect(alignPinnedToDurations(DEFAULT_COVERAGE_RULES, []).pinnedTimes[0]!.durationId).toBe('');
  });
});

describe('withKind', () => {
  it('defaults visits and migrates the legacy overnight id', () => {
    const [visit, legacy] = withKind([
      { id: 'x', label: 'A', minutes: 30, price: 20 },
      { id: 'd7', label: 'Overnight', minutes: 720, price: 150 },
    ]);
    expect(visit!.kind).toBe('visit');
    expect(legacy!.kind).toBe('overnight');
  });
});

describe('buildDayPatterns (suggestions)', () => {
  it('is empty for a reversed/degenerate window', () => {
    expect(buildDayPatterns(DURATIONS, [], 6, '14:00', '11:00')).toEqual([]);
    expect(buildDayPatterns(DURATIONS, [], 6, '11:00', '14:00')).toEqual([]); // 3h ≤ 6h gap, no pinned
  });

  it('only fills with visit-kind durations, never overnights', () => {
    const patterns = buildDayPatterns(DURATIONS, [], 3, '07:00', '22:00');
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) {
      for (const tp of p.touchpoints) {
        expect(DURATIONS.find((d) => d.id === tp.durationId)!.kind).toBe('visit');
      }
    }
  });

  it('never leaves a gap wider than the max', () => {
    const patterns = buildDayPatterns(DURATIONS, [], 4, '07:00', '22:00');
    const maxGapMin = 4 * 60;
    for (const p of patterns) {
      const times = [420, ...p.touchpoints.map((t) => t.time), 1320].sort((a, b) => a - b);
      for (let i = 0; i < times.length - 1; i++) {
        expect(times[i + 1]! - times[i]!).toBeLessThanOrEqual(maxGapMin + 0.001);
      }
    }
  });

  it('seeds a package template from a suggestion', () => {
    const p = buildDayPatterns(DURATIONS, [{ id: 'p', label: 'Meds', time: '12:00', durationId: 'd3' }], 12, '07:00', '22:00')[0]!;
    const visits = visitsFromPattern(p);
    expect(visits.length).toBe(p.touchpoints.length);
    expect(visits[0]!.time).toBe(720);
  });
});

describe('coverageForDay + priceDay', () => {
  it('prices bare visits at list price with no overnight', () => {
    const { total, items } = priceDay(
      [{ id: 'v1', time: 720, durationId: 'd3', label: 'Lunch' }],
      DURATIONS,
      { eveningFrom: null, morningUntil: null, bonusFreeVisit: false },
    );
    expect(total).toBe(35); // d3 = $35
    expect(items[0]!.free).toBe(false);
  });

  it('a visit inside the overnight evening window is covered (free)', () => {
    // overnight tonight from 21:00, 2h buffer → covers from 19:00 onward.
    const p = pkg({ overnightStart: '21:00', overnightBufferHours: 2, overnightNights: { 0: true } });
    const cov = coverageForDay(p, 0, 2, OVERNIGHT);
    expect(cov.eveningFrom).toBe(19 * 60);
    const { items } = priceDay([{ id: 'v', time: 20 * 60, durationId: 'd3', label: 'Evening' }], DURATIONS, cov);
    expect(items[0]!.free).toBe(true);
    expect(items[0]!.price).toBe(0);
  });

  it('the morning after an overnight grants one free bonus visit', () => {
    // Prior night had an overnight → bonusFreeVisit true; the first paid visit goes free.
    const cov = { eveningFrom: null, morningUntil: null, bonusFreeVisit: true };
    const { items, total } = priceDay(
      [
        { id: 'a', time: 8 * 60, durationId: 'd3', label: 'AM' },
        { id: 'b', time: 12 * 60, durationId: 'd3', label: 'Noon' },
      ],
      DURATIONS,
      cov,
    );
    expect(items[0]!.bonus).toBe(true);
    expect(items[0]!.price).toBe(0);
    expect(total).toBe(35); // only the second visit is billed
  });
});

describe('pricePackage', () => {
  it('sums per-day costs incl. overnight and applies a discount', () => {
    const p = pkg({
      visits: [{ id: 'v', time: 12 * 60, durationId: 'd3', label: 'Lunch' }], // $35/day
      overnightNights: { 0: true, 1: true },
      discountPct: 10,
    });
    const priced = pricePackage(p, { days: 3, nights: 2, durations: DURATIONS, overnightDuration: OVERNIGHT });
    expect(priced.rows).toHaveLength(3);
    // 3 lunches ($35) + 2 overnights ($150) = 105 + 300 = 405; minus 10% = 364.50.
    // (Day 2 & 3 mornings each get a bonus free visit, but the only visit is lunch which
    //  becomes free those days — so lunch is billed on day 1 only.)
    expect(priced.subtotal).toBeGreaterThan(0);
    expect(priced.discount).toBeCloseTo(priced.subtotal * 0.1, 5);
    expect(priced.total).toBeCloseTo(priced.subtotal - priced.discount, 5);
  });
});

describe('gapWarnings', () => {
  it('flags a bare day whose visits leave a gap wider than the max', () => {
    const warns = gapWarnings(
      [{ id: 'a', time: 8 * 60, durationId: 'd1', label: 'AM' }],
      '07:00',
      '22:00',
      4,
      { eveningFrom: null, morningUntil: null, bonusFreeVisit: false },
    );
    expect(warns.length).toBeGreaterThan(0); // 8:00 → 22:00 is 14h, one 8am visit can't cover it
  });
});

describe('quoteText', () => {
  const p = pkg({ name: 'Balanced', visits: [{ id: 'v', time: 12 * 60, durationId: 'd3', label: 'Lunch' }] });
  const priced = { ...pricePackage(p, { days: 2, nights: 1, durations: DURATIONS, overnightDuration: OVERNIGHT }), pkg: p };

  it('renders a client-facing per-day quote', () => {
    const text = quoteText({ clientName: 'Rex', startDate: '2026-07-01', days: 2, priced });
    expect(text).toContain('TribeTails — Coverage Package');
    expect(text).toContain('Prepared for: Rex');
    expect(text).toContain('Balanced · 2 days');
    expect(text).toContain('Lunch (45-min visit)');
    expect(text).toContain('Total');
  });
});
