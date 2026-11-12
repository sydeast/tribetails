import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COVERAGE_RULES,
  DEFAULT_DURATIONS,
  alignPinnedToDurations,
  buildDayPatterns,
  coverageForDay,
  DATE_ORDER_REFUSAL,
  dateRangeRefusal,
  daysBetween,
  BUFFER_REFUSAL,
  DISCOUNT_REFUSAL,
  PACKAGE_DEFAULTS,
  parseBufferHours,
  parseDiscountPct,
  storedPackageRefusals,
  durationsFromServiceRates,
  gapWarnings,
  minutesToTime,
  normalizePackage,
  dayDiffersFromTemplate,
  uniqueCopyName,
  parseMaxGapHours,
  sanitizeStoredRules,
  storedMaxGapRefusal,
  packagesFromPatterns,
  packageNote,
  typeIntoFields,
  closeFieldEdits,
  type FieldDrafts,
  type PackageFieldParse,
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

describe('seeding tiers off a KinCare menu (#728 rebase, issue #694)', () => {
  it('seeds three tiers with no visit lacking a duration, even off the shipped default pin', () => {
    // DEFAULT_COVERAGE_RULES pins `d2`, an id from the deleted builder-owned
    // menu. #728 made the service NAME the duration id, so `d2` resolves in no
    // real menu. Seeding tiers straight off DEFAULT_COVERAGE_RULES (skipping
    // alignPinnedToDurations) would carry that dead pin into every tier as a
    // touchpoint with no matching Duration: a $0 "no duration set" visit.
    const menu = durationsFromServiceRates({ '30Minute': '25', '60Minute': '45', Overnight: '150' });
    const rules = alignPinnedToDurations(DEFAULT_COVERAGE_RULES, menu);
    const patterns = buildDayPatterns(menu, rules.pinnedTimes, rules.maxGapHours, rules.wakeStart, rules.wakeEnd);
    const packages = packagesFromPatterns(patterns);
    expect(packages).toHaveLength(3);
    const knownIds = new Set(menu.map((d) => d.id));
    for (const p of packages) {
      expect(p.visits.length).toBeGreaterThan(0);
      for (const visit of p.visits) {
        expect(visit.durationId).not.toBe('');
        expect(knownIds.has(visit.durationId)).toBe(true);
      }
    }
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

describe('buildDayPatterns tiers (issue #694)', () => {
  /**
   * The operator's live config, the one commit cd1aaab called degenerate and
   * made return nothing: an 11:00-14:00 day inside a 6h max gap, no pinned visit.
   * The Packages screen then offered only "New package".
   */
  const DEGENERATE = () => buildDayPatterns(DURATIONS, [], 6, '11:00', '14:00');

  it('builds all three tiers for the config that used to build none', () => {
    const patterns = DEGENERATE();
    expect(patterns).toHaveLength(3);
    // Cheapest first, and the strategy keys are the stable ids.
    expect(patterns.map((p) => p.id)).toEqual(['cheapest', 'mid', 'richest']);
    for (const p of patterns) expect(p.touchpoints.length).toBeGreaterThan(0);
  });

  it('uses the operator\'s names: Lean, Balance, Premium', () => {
    expect(DEGENERATE().map((p) => p.strategyLabel)).toEqual(['Lean', 'Balance', 'Premium']);
  });

  it('says on the card why a degraded tier is one check-in', () => {
    for (const p of DEGENERATE()) {
      expect(p.note).toMatch(/fits inside the 6h max gap/);
      expect(p.note).toContain('12:30 PM'); // the middle of an 11:00-14:00 day
      expect(p.touchpoints).toHaveLength(1);
      // A length that cannot fit the 3h day is never the one it degrades to.
      expect(DURATIONS.find((d) => d.id === p.touchpoints[0]!.durationId)!.minutes).toBeLessThanOrEqual(180);
    }
  });

  it('builds on the shipped day when the window is reversed, and says so', () => {
    const patterns = buildDayPatterns(DURATIONS, [], 6, '14:00', '11:00');
    expect(patterns).toHaveLength(3);
    for (const p of patterns) expect(p.note).toMatch(/7:00 AM to 10:00 PM/);
  });

  it('carries no note when the tier meets the rules as written', () => {
    for (const p of buildDayPatterns(DURATIONS, [], 3, '07:00', '22:00')) expect(p.note).toBe('');
  });

  it('keeps three tiers even when they price the same', () => {
    // One priced visit type: every strategy picks it, and the three used to
    // dedupe down to a single card.
    const one: readonly Duration[] = [{ id: 'v', label: 'Drop-in', minutes: 30, price: 25, kind: 'visit' }];
    const patterns = buildDayPatterns(one, [], 6, '11:00', '14:00');
    expect(patterns.map((p) => p.strategyLabel)).toEqual(['Lean', 'Balance', 'Premium']);
  });

  it('builds nothing when there is no priced visit to sell', () => {
    const unpriced: readonly Duration[] = [
      { id: 'v', label: 'Drop-in', minutes: 30, price: 0, kind: 'visit' },
      { id: 'o', label: 'Overnight', minutes: 720, price: 150, kind: 'overnight' },
    ];
    expect(buildDayPatterns(unpriced, [], 6, '07:00', '22:00')).toEqual([]);
  });

  it('turns the tiers into editable packages that store no note (#1858)', () => {
    const packages = packagesFromPatterns(DEGENERATE());
    expect(packages.map((p) => p.name)).toEqual(['Lean', 'Balance', 'Premium']);
    expect(packages[0]!.visits).toHaveLength(1);
    // The sentence lives on the pattern and is read off the current rules.
    for (const p of packages) expect(p).not.toHaveProperty('note');
    // Distinct ids, so the operator can delete or edit one without the others.
    expect(new Set(packages.map((p) => p.id)).size).toBe(3);
  });
});
describe('buildDayPatterns (fill)', () => {
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
  const p = pkg({ name: 'Balance', visits: [{ id: 'v', time: 12 * 60, durationId: 'd3', label: 'Lunch' }] });
  const priced = { ...pricePackage(p, { days: 2, nights: 1, durations: DURATIONS, overnightDuration: OVERNIGHT }), pkg: p };

  it('renders a client-facing per-day quote', () => {
    const text = quoteText({ clientName: 'Rex', startDate: '2026-07-01', days: 2, priced });
    expect(text).toContain('TribeTails — Coverage Package');
    expect(text).toContain('Prepared for: Rex');
    expect(text).toContain('Balance · 2 days');
    expect(text).toContain('Lunch (45-min visit)');
    expect(text).toContain('Total');
  });
});

describe('dayDiffersFromTemplate (#1605)', () => {
  const visit = (id: string, time: number, label = 'Check-in') => ({ id, time, durationId: 'd1', label });
  const base = normalizePackage({ id: 'p', name: 'P', visits: [visit('a', 540), visit('b', 720)] });
  it('is false with no day copy', () => {
    expect(dayDiffersFromTemplate(base, 0)).toBe(false);
  });
  it('is false for a fresh fork, whatever ids it minted', () => {
    const forked = { ...base, dayOverrides: { 0: [visit('x', 720), visit('y', 540)] } };
    expect(dayDiffersFromTemplate(forked, 0)).toBe(false);
  });
  it('is true once a time, length, label or count changes', () => {
    expect(dayDiffersFromTemplate({ ...base, dayOverrides: { 0: [visit('x', 540), visit('y', 780)] } }, 0)).toBe(true);
    expect(dayDiffersFromTemplate({ ...base, dayOverrides: { 0: [visit('x', 540, 'Walk'), visit('y', 720)] } }, 0)).toBe(true);
    expect(dayDiffersFromTemplate({ ...base, dayOverrides: { 0: [visit('x', 540)] } }, 0)).toBe(true);
  });
  it('feeds the priced row', () => {
    const forked = { ...base, dayOverrides: { 0: base.visits.map((v) => ({ ...v, id: `n${v.id}` })) } };
    const row = pricePackage(forked, { days: 1, nights: 0, durations: DURATIONS, overnightDuration: undefined }).rows[0]!;
    expect(row.customized).toBe(true);
    expect(row.changed).toBe(false);
  });
});
describe('uniqueCopyName (#1605)', () => {
  it('adds copy, then numbers further copies', () => {
    expect(uniqueCopyName('Lean', ['Lean'])).toBe('Lean copy');
    expect(uniqueCopyName('Lean', ['Lean', 'Lean copy'])).toBe('Lean copy 2');
    expect(uniqueCopyName('Lean', ['Lean', 'Lean copy', 'Lean copy 2'])).toBe('Lean copy 3');
  });
  it('copying a copy extends the original name instead of stacking', () => {
    expect(uniqueCopyName('Lean copy', ['Lean', 'Lean copy'])).toBe('Lean copy 2');
    expect(uniqueCopyName('Lean copy 2', ['Lean', 'Lean copy', 'Lean copy 2'])).toBe('Lean copy 3');
  });
});
describe('parseMaxGapHours (#1582)', () => {
  it('reads whole and fractional hours', () => {
    expect(parseMaxGapHours('6')).toEqual({ ok: true, value: 6 });
    expect(parseMaxGapHours(' 4.5 ')).toEqual({ ok: true, value: 4.5 });
    expect(parseMaxGapHours('1')).toEqual({ ok: true, value: 1 });
    // No upper bound: how long a gap the client accepts is the operator's call.
    expect(parseMaxGapHours('30')).toEqual({ ok: true, value: 30 });
  });
  it('refuses a minus sign, a bare minus, and anything that is not a plain number', () => {
    for (const bad of ['-5', '-', '+5', '1e3', 'abc', '4.', '.5', '5h', '1,5']) {
      expect(parseMaxGapHours(bad).ok, bad).toBe(false);
    }
    expect(parseMaxGapHours('-5')).toMatchObject({ ok: false, message: expect.stringMatching(/minus sign/) });
  });
  it('refuses blank, zero and under one hour', () => {
    expect(parseMaxGapHours('')).toMatchObject({ ok: false, message: expect.stringMatching(/Enter the longest gap/) });
    for (const out of ['0', '0.5']) {
      expect(parseMaxGapHours(out), out).toMatchObject({ ok: false, message: 'Max gap must be at least 1 hour.' });
    }
  });
});
describe('sanitizeStoredRules (#1582)', () => {
  it('keeps a readable max gap as it is', () => {
    for (const gap of [4.5, 30]) {
      const rules = { ...DEFAULT_COVERAGE_RULES, maxGapHours: gap };
      expect(sanitizeStoredRules(rules)).toBe(rules);
      expect(storedMaxGapRefusal(rules)).toBeNull();
    }
  });
  it('names why a stored gap is refused', () => {
    expect(storedMaxGapRefusal({ ...DEFAULT_COVERAGE_RULES, maxGapHours: -5 })).toMatch(/minus sign/);
    expect(storedMaxGapRefusal({ ...DEFAULT_COVERAGE_RULES, maxGapHours: 0 })).toBe('Max gap must be at least 1 hour.');
  });
  it('prices an unreadable stored max gap at the default', () => {
    for (const bad of [-5, 0, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sanitizeStoredRules({ ...DEFAULT_COVERAGE_RULES, maxGapHours: bad }).maxGapHours, String(bad)).toBe(
        DEFAULT_COVERAGE_RULES.maxGapHours,
      );
    }
  });
});

describe('parseDiscountPct (#1593)', () => {
  it('reads blank as no discount and takes whole and decimal percents from 0 to 100', () => {
    expect(parseDiscountPct('')).toEqual({ ok: true, value: 0 });
    expect(parseDiscountPct('  ')).toEqual({ ok: true, value: 0 });
    expect(parseDiscountPct('0')).toEqual({ ok: true, value: 0 });
    expect(parseDiscountPct(' 12.5 ')).toEqual({ ok: true, value: 12.5 });
    expect(parseDiscountPct('100')).toEqual({ ok: true, value: 100 });
  });
  it('refuses 150, -20, abc and anything that is not a plain number, never capping it', () => {
    for (const bad of ['150', '100.5', '-20', '-', 'abc', '+5', '1e2', '10%', '1,5', '5.']) {
      expect(parseDiscountPct(bad), bad).toEqual({ ok: false, message: DISCOUNT_REFUSAL });
    }
    expect(DISCOUNT_REFUSAL).toBe('Enter a discount from 0 to 100 percent.');
  });
});
describe('parseBufferHours (#1593)', () => {
  it('takes 0 or more hours, whole or decimal, with no upper bound', () => {
    expect(parseBufferHours('0')).toEqual({ ok: true, value: 0 });
    expect(parseBufferHours('1')).toEqual({ ok: true, value: 1 });
    expect(parseBufferHours(' 1.5 ')).toEqual({ ok: true, value: 1.5 });
    expect(parseBufferHours('12')).toEqual({ ok: true, value: 12 });
  });
  it('refuses abc, -1, blank and anything that is not a plain number', () => {
    for (const bad of ['abc', '-1', '-', '', '  ', '+1', '1e2', '1.', '2h']) {
      expect(parseBufferHours(bad), JSON.stringify(bad)).toEqual({ ok: false, message: BUFFER_REFUSAL });
    }
    expect(BUFFER_REFUSAL).toBe('Enter the buffer in hours, 0 or more, like 1 or 1.5.');
  });
});
describe('stored discount and buffer (#1593)', () => {
  it('names a stored value the field would refuse, as stored', () => {
    expect(storedPackageRefusals({ discountPct: 150, overnightBufferHours: -1 })).toEqual({ discount: '150', buffer: '-1' });
    expect(storedPackageRefusals({ discountPct: 10, overnightBufferHours: 1.5 })).toEqual({ discount: null, buffer: null });
    // Absent means the default, not a refusal.
    expect(storedPackageRefusals({})).toEqual({ discount: null, buffer: null });
  });
  it('prices a refused stored value at the default, and keeps a readable one', () => {
    const refused = normalizePackage({ id: 'x', discountPct: 150, overnightBufferHours: -1 });
    expect(refused.discountPct).toBe(PACKAGE_DEFAULTS.discountPct);
    expect(refused.overnightBufferHours).toBe(PACKAGE_DEFAULTS.overnightBufferHours);
    const kept = normalizePackage({ id: 'y', discountPct: 12.5, overnightBufferHours: 0 });
    expect(kept.discountPct).toBe(12.5);
    // 0 is a real buffer, not a missing one.
    expect(kept.overnightBufferHours).toBe(0);
    expect(normalizePackage({ id: 'z' }).overnightBufferHours).toBe(PACKAGE_DEFAULTS.overnightBufferHours);
  });
});
describe('dateRangeRefusal (#1593)', () => {
  it('refuses an End before the Start', () => {
    expect(dateRangeRefusal('2026-07-05', '2026-07-01')).toBe(DATE_ORDER_REFUSAL);
    expect(DATE_ORDER_REFUSAL).toBe('The end date has to be on or after the start date.');
  });
  it('takes the same day, a later End, and a range not yet set', () => {
    expect(dateRangeRefusal('2026-07-01', '2026-07-01')).toBeNull();
    expect(dateRangeRefusal('2026-07-01', '2026-07-05')).toBeNull();
    expect(dateRangeRefusal('2026-07-01', '')).toBeNull();
    expect(dateRangeRefusal('', '2026-07-01')).toBeNull();
  });
});

describe('packageNote (#1858)', () => {
  const short = (gap: number) => buildDayPatterns(DURATIONS, [], gap, '11:00', '14:00');
  const tier = (gap: number) => packagesFromPatterns(short(gap))[0]!;
  it('reads the sentence off the rules as they are now, not as they were when the tier was built', () => {
    const built = tier(24);
    expect(packageNote(built, short(24))).toBe('The 3h day fits inside the 24h max gap, so this tier is one check-in at 12:30 PM.');
    expect(packageNote(built, short(6))).toBe('The 3h day fits inside the 6h max gap, so this tier is one check-in at 12:30 PM.');
  });
  it('is empty once the rules no longer build that tier', () => {
    // A 2h gap fills the 3h day on purpose; a 15h day under a 6h gap builds three check-ins.
    expect(packageNote(tier(24), short(2))).toBe('');
    expect(packageNote(tier(24), buildDayPatterns(DURATIONS, [], 6, '07:00', '22:00'))).toBe('');
  });
  it('is empty once the visit is removed, moved or joined by another', () => {
    const built = tier(6);
    const only = built.visits[0]!;
    expect(packageNote({ ...built, visits: [] }, short(6))).toBe('');
    expect(packageNote({ ...built, visits: [{ ...only, time: only.time + 30 }] }, short(6))).toBe('');
    expect(packageNote({ ...built, visits: [only, { ...only, id: 'x', time: 800 }] }, short(6))).toBe('');
  });
  it('ignores the label, the ids and the order the visits are held in', () => {
    const built = tier(6);
    expect(packageNote({ ...built, visits: [{ ...built.visits[0]!, id: 'copy', label: 'Lunch' }] }, short(6))).not.toBe('');
    const pinned = [
      { id: 'a', label: 'AM', time: '15:00', durationId: 'd2' },
      { id: 'b', label: 'PM', time: '12:00', durationId: 'd3' },
    ];
    // A reversed day window still explains itself on a tier with several visits.
    const patterns = buildDayPatterns(DURATIONS, pinned, 6, '14:00', '11:00');
    const many = packagesFromPatterns(patterns)[0]!;
    expect(many.visits.length).toBeGreaterThan(1);
    expect(packageNote({ ...many, visits: [...many.visits].reverse() }, patterns)).toMatch(/7:00 AM to 10:00 PM/);
  });
  it('is empty for a tier that met the rules and for an empty package', () => {
    const met = buildDayPatterns(DURATIONS, [], 3, '07:00', '22:00');
    expect(packageNote(packagesFromPatterns(met)[0]!, met)).toBe('');
    expect(packageNote(pkg(), short(6))).toBe('');
  });
  it('a stored package loses the sentence it was saved with', () => {
    const loaded = normalizePackage({ id: 'x', name: 'Balance', note: 'The 2h day fits inside the 24h max gap.' } as Partial<Package>);
    expect(loaded).not.toHaveProperty('note');
  });
});
describe('typeIntoFields (#2021)', () => {
  /** Types `text` one key at a time, the way the screen feeds it. */
  function typeKeys(
    start: { drafts: FieldDrafts; value: number },
    key: string,
    text: string,
    parse: (t: string) => PackageFieldParse = parseDiscountPct,
  ): { drafts: FieldDrafts; value: number } {
    let state = start;
    for (let i = 1; i <= text.length; i++) {
      const typed = text.slice(0, i);
      const parsed = parse(typed);
      state = typeIntoFields(state.drafts, key, state.value, typed, parsed.ok ? parsed.value : null);
    }
    return state;
  }
  const EMPTY = { drafts: {} as FieldDrafts, value: 0 };
  it('prices each good keystroke as it is typed', () => {
    expect(typeKeys(EMPTY, 'd', '2').value).toBe(2);
    expect(typeKeys(EMPTY, 'd', '20').value).toBe(20);
    expect(typeKeys(EMPTY, 'd', '12.5').value).toBe(12.5);
  });
  it('150 passes through 1 and 15 and prices at the value held before the edit', () => {
    const after = typeKeys(EMPTY, 'd', '150');
    expect(after.value).toBe(0);
    expect(after.drafts.d).toEqual({ text: '150', before: 0, open: true });
    expect(typeKeys({ drafts: {}, value: 20 }, 'd', '250').value).toBe(20);
  });
  it('takes 100, 0 and blank; refuses 101, a minus and letters', () => {
    expect(typeKeys({ drafts: {}, value: 20 }, 'd', '100').value).toBe(100);
    expect(typeKeys({ drafts: {}, value: 20 }, 'd', '0').value).toBe(0);
    expect(typeIntoFields({}, 'd', 20, '', 0).value).toBe(0);
    expect(typeKeys({ drafts: {}, value: 20 }, 'd', '101').value).toBe(20);
    expect(typeKeys({ drafts: {}, value: 20 }, 'd', '-5').value).toBe(20);
    expect(typeKeys({ drafts: {}, value: 20 }, 'd', 'abc').value).toBe(20);
    expect(typeKeys({ drafts: {}, value: 20 }, 'd', '15x').value).toBe(20);
  });
  it('deleting the bad key prices what is left', () => {
    const bad = typeKeys(EMPTY, 'd', '150');
    expect(typeIntoFields(bad.drafts, 'd', bad.value, '15', 15).value).toBe(15);
  });
  it('a closed edit is a choice: 20, close, then 200 prices at 20', () => {
    const chosen = typeKeys(EMPTY, 'd', '20');
    const closed = { drafts: closeFieldEdits(chosen.drafts), value: chosen.value };
    expect(closed.drafts.d).toEqual({ text: '20', before: 0, open: false });
    const again = typeIntoFields(closed.drafts, 'd', closed.value, '200', null);
    expect(again.value).toBe(20);
    expect(again.drafts.d).toEqual({ text: '200', before: 20, open: true });
  });
  it('without a close the same edit goes on: 20 then 200 prices at the value before the 20', () => {
    const chosen = typeKeys(EMPTY, 'd', '20');
    expect(typeIntoFields(chosen.drafts, 'd', chosen.value, '200', null).value).toBe(0);
  });
  it('typing in one field closes the edit in every other', () => {
    const first = typeKeys(EMPTY, 'a:discount', '20');
    const second = typeIntoFields(first.drafts, 'b:discount', 0, '5', 5);
    expect(second.drafts['a:discount']!.open).toBe(false);
    expect(second.drafts['b:discount']!.open).toBe(true);
    expect(typeIntoFields(second.drafts, 'a:discount', 20, '200', null).value).toBe(20);
  });
  it('closing with nothing open hands back the same map', () => {
    const none: FieldDrafts = {};
    expect(closeFieldEdits(none)).toBe(none);
    const closed = closeFieldEdits(typeKeys(EMPTY, 'd', '20').drafts);
    expect(closeFieldEdits(closed)).toBe(closed);
  });
  it('keeps the buffer and the max gap held before the edit the same way', () => {
    expect(typeKeys({ drafts: {}, value: 2 }, 'b', '12a', parseBufferHours).value).toBe(2);
    const gap = (t: string): PackageFieldParse => parseMaxGapHours(t);
    expect(typeKeys({ drafts: {}, value: 6 }, 'g', '12a', gap).value).toBe(6);
    expect(typeKeys({ drafts: {}, value: 6 }, 'g', '4.5', gap).value).toBe(4.5);
  });
});
