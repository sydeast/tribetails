import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DURATIONS,
  buildDayPatterns,
  daysBetween,
  minutesToTime,
  quoteText,
  timeToMinutes,
  type CoverageRules,
  type Duration,
} from './coveragePackage';

const DURATIONS: readonly Duration[] = DEFAULT_DURATIONS;

function rules(over: Partial<CoverageRules> = {}): CoverageRules {
  return { wakeStart: '07:00', wakeEnd: '22:00', maxGapHours: 6, pinnedTimes: [], ...over };
}

describe('daysBetween', () => {
  it('counts inclusively', () => {
    expect(daysBetween('2026-07-01', '2026-07-01')).toBe(1);
    expect(daysBetween('2026-07-01', '2026-07-05')).toBe(5);
  });
  it('is 0 for unset or reversed ranges', () => {
    expect(daysBetween('', '2026-07-05')).toBe(0);
    expect(daysBetween('2026-07-05', '')).toBe(0);
    expect(daysBetween('2026-07-05', '2026-07-01')).toBe(0);
  });
  it('spans a month boundary', () => {
    expect(daysBetween('2026-07-30', '2026-08-02')).toBe(4);
  });
});

describe('timeToMinutes / minutesToTime', () => {
  it('parses HH:MM to minutes since midnight', () => {
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('07:30')).toBe(450);
    expect(timeToMinutes('22:00')).toBe(1320);
  });
  it('returns null for blank or malformed input', () => {
    expect(timeToMinutes('')).toBeNull();
    expect(timeToMinutes('nope')).toBeNull();
  });
  it('formats minutes to a 12h label', () => {
    expect(minutesToTime(0)).toBe('12:00 AM');
    expect(minutesToTime(450)).toBe('7:30 AM');
    expect(minutesToTime(750)).toBe('12:30 PM');
    expect(minutesToTime(1320)).toBe('10:00 PM');
  });
});

describe('buildDayPatterns', () => {
  it('returns nothing when the day window is empty or reversed', () => {
    expect(buildDayPatterns(DURATIONS, rules({ wakeEnd: '07:00' }), false, 'd7')).toEqual([]);
    expect(buildDayPatterns(DURATIONS, rules({ wakeStart: '', wakeEnd: '' }), false, 'd7')).toEqual([]);
  });

  it('never leaves a gap wider than the max between visits or window edges', () => {
    const r = rules({ maxGapHours: 4 });
    const maxGapMin = r.maxGapHours * 60;
    const patterns = buildDayPatterns(DURATIONS, r, false, 'd7');
    expect(patterns.length).toBeGreaterThan(0);
    const start = timeToMinutes(r.wakeStart)!;
    const end = timeToMinutes(r.wakeEnd)!;
    for (const p of patterns) {
      const times = [start, ...p.touchpoints.map((t) => t.time), end].sort((a, b) => a - b);
      for (let i = 0; i < times.length - 1; i++) {
        // Rounded: fill times are fractional, and the builder rounds for its signature.
        expect(times[i + 1]! - times[i]!).toBeLessThanOrEqual(maxGapMin + 0.001);
      }
    }
  });

  it('includes every pinned visit in each pattern at its pinned time', () => {
    const r = rules({
      pinnedTimes: [{ id: 'p1', label: 'Meds', time: '12:00', durationId: 'd3' }],
    });
    const patterns = buildDayPatterns(DURATIONS, r, false, 'd7');
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) {
      const pinned = p.touchpoints.find((t) => t.type === 'pinned');
      expect(pinned).toBeDefined();
      expect(pinned!.time).toBe(720);
      expect(pinned!.label).toBe('Meds');
      // Priced at the pinned duration (d3 = $28), not the fill duration.
      expect(pinned!.price).toBe(28);
    }
  });

  it('adds overnight cost and label only when requested', () => {
    const withOn = buildDayPatterns(DURATIONS, rules(), true, 'd7');
    const withoutOn = buildDayPatterns(DURATIONS, rules(), false, 'd7');
    expect(withOn.length).toBeGreaterThan(0);
    for (const p of withOn) {
      expect(p.overnightLabel).toBe('Overnight (12hr)');
      expect(p.overnightCost).toBe(150);
    }
    for (const p of withoutOn) {
      expect(p.overnightLabel).toBeNull();
      expect(p.overnightCost).toBe(0);
    }
  });

  it('orders patterns cheapest-first and dedupes identical strategies', () => {
    // A single eligible duration collapses cheapest/mid/richest to one pattern.
    const single: Duration[] = [{ id: 'only', label: '30-min', minutes: 30, price: 20 }];
    const patterns = buildDayPatterns(single, rules({ maxGapHours: 4 }), false, 'd7');
    expect(patterns.length).toBe(1);

    const many = buildDayPatterns(DURATIONS, rules({ maxGapHours: 3 }), false, 'd7');
    for (let i = 0; i < many.length - 1; i++) {
      expect(many[i]!.dayTotal).toBeLessThanOrEqual(many[i + 1]!.dayTotal);
    }
  });

  it('emits nothing when the rules need no visits (window fits inside the max gap, no pinned)', () => {
    // The exact prod config that showed a phantom $0 "Lean" card: an 11:00–14:00
    // window (3h) is narrower than the 6h max gap and there are no pinned visits,
    // so no visit is required. All three strategies collapse to the same empty
    // schedule; without the guard they would dedupe to a single $0 tier.
    const degenerate = rules({ wakeStart: '11:00', wakeEnd: '14:00', maxGapHours: 6, pinnedTimes: [] });
    expect(buildDayPatterns(DURATIONS, degenerate, false, 'd7')).toEqual([]);
  });

  it('still emits an overnight-only schedule when no day visits are needed but overnight is on', () => {
    // Same degenerate day window, but overnight coverage requested — that IS a
    // real (overnight-only) option, so exactly one priced pattern survives.
    const degenerate = rules({ wakeStart: '11:00', wakeEnd: '14:00', maxGapHours: 6, pinnedTimes: [] });
    const patterns = buildDayPatterns(DURATIONS, degenerate, true, 'd7');
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.touchpoints).toHaveLength(0);
    expect(patterns[0]!.overnightCost).toBe(150);
    expect(patterns[0]!.dayTotal).toBe(150);
  });
});

describe('quoteText', () => {
  // A large max gap with one pinned visit yields a single deterministic pattern
  // (pinned Meds at 12:00, priced at d3 = $28), so the quote is stable.
  const r = rules({ maxGapHours: 12, pinnedTimes: [{ id: 'p1', label: 'Meds', time: '12:00', durationId: 'd3' }] });
  const pattern = buildDayPatterns(DURATIONS, r, false, 'd7')[0]!;

  it('renders a clean client-facing quote with per-day and stay totals', () => {
    const text = quoteText({
      clientName: 'Rex',
      startDate: '2026-07-01',
      endDate: '2026-07-03',
      days: 3,
      pattern,
    });
    expect(text).toContain('TribeTails — Coverage Package');
    expect(text).toContain('Prepared for: Rex');
    expect(text).toContain('12:00 PM');
    expect(text).toContain('Meds (45-min visit)');
    expect(text).toContain('Per day   $28.00');
    expect(text).toContain('Total (3 days)   $84.00');
  });

  it('omits the client line when no name is given', () => {
    const text = quoteText({ clientName: '', startDate: '', endDate: '', days: 1, pattern });
    expect(text).not.toContain('Prepared for');
    expect(text).toContain('Total (1 day)   $28.00');
  });
});
