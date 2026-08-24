import { describe, expect, it } from 'vitest';
import {
  BOOKING_HORIZON_DAYS,
  MAX_RECURRING_VISITS,
  bookingHorizonEnd,
  buildVisits,
  buildWeeklyVisits,
  dateKey,
  isBookableDay,
  monthIndex,
  monthPickerDays,
  parseHourMinute,
  priceLabel,
  shiftMonth,
  weeklyPotentialCount,
  weeklyVisitsBlocker,
} from './bookingWizardLogic';

const SERVICE = { id: 's1', name: "Auntie's In", priceCents: 1500 as number | null, priceMinCents: null as number | null };

describe('parseHourMinute', () => {
  it('parses a valid HH:MM', () => {
    expect(parseHourMinute('09:00')).toEqual({ hour: 9, minute: 0 });
    expect(parseHourMinute('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it('trims surrounding whitespace on each part', () => {
    expect(parseHourMinute(' 9 : 5 ')).toEqual({ hour: 9, minute: 5 });
  });

  it('rejects out-of-range hour/minute', () => {
    expect(parseHourMinute('24:00')).toBeNull();
    expect(parseHourMinute('09:60')).toBeNull();
  });

  it('rejects malformed strings', () => {
    expect(parseHourMinute('9')).toBeNull();
    expect(parseHourMinute('9:30:00')).toBeNull();
    expect(parseHourMinute('nine:thirty')).toBeNull();
    expect(parseHourMinute('9.5:00')).toBeNull();
    expect(parseHourMinute('')).toBeNull();
  });
});

describe('weeklyPotentialCount', () => {
  it('is days x weeks', () => {
    expect(weeklyPotentialCount(new Set([1, 3, 5]), 4)).toBe(12);
  });

  it('is 0 for weeks < 1', () => {
    expect(weeklyPotentialCount(new Set([1]), 0)).toBe(0);
  });
});

describe('weeklyVisitsBlocker', () => {
  it('requires at least one weekday', () => {
    expect(weeklyVisitsBlocker(new Set(), 4, '09:00')).toBe('Pick at least one day of the week.');
  });

  it('requires weeks >= 1', () => {
    expect(weeklyVisitsBlocker(new Set([1]), 0, '09:00')).toBe('Choose how many weeks.');
  });

  it('requires a valid time', () => {
    expect(weeklyVisitsBlocker(new Set([1]), 4, 'bad')).toBe('Enter a valid time as HH:MM.');
  });

  it('is null once all three are satisfied', () => {
    expect(weeklyVisitsBlocker(new Set([1]), 4, '09:00')).toBeNull();
  });
});

describe('buildWeeklyVisits', () => {
  // Fixed reference instant: Wed 2026-07-15 08:00 local.
  const NOW = new Date(2026, 6, 15, 8, 0, 0).getTime();

  it('emits one visit per matching weekday across the requested week count', () => {
    // Mon(1) + Wed(3), 2 weeks, from Wed 2026-07-15. Wed today at 09:00 is
    // still in the future (now is 08:00), so it counts; the walk covers
    // offsets 0..13 (14 days = 2 weeks).
    const visits = buildWeeklyVisits({
      nowMs: NOW,
      weeklyDays: new Set([1, 3]),
      weeks: 2,
      time: { hour: 9, minute: 0 },
      serviceId: SERVICE.id,
      serviceName: SERVICE.name,
      priceCents: SERVICE.priceCents,
    });
    // Wed Jul15, Mon Jul20, Wed Jul22, Mon Jul27 = 4 visits.
    expect(visits).toHaveLength(4);
    expect(visits.every((v) => v.startTimeMs > NOW)).toBe(true);
    expect(visits.every((v) => v.serviceId === 's1' && v.serviceName === "Auntie's In")).toBe(true);
    // Strictly increasing (walk order == chronological order).
    for (let i = 1; i < visits.length; i++) {
      expect(visits[i]!.startTimeMs).toBeGreaterThan(visits[i - 1]!.startTimeMs);
    }
  });

  it('drops a same-day occurrence whose time has already passed today', () => {
    // Today is Wed(3); ask for 07:00 which is before "now" (08:00).
    const visits = buildWeeklyVisits({
      nowMs: NOW,
      weeklyDays: new Set([3]),
      weeks: 1,
      time: { hour: 7, minute: 0 },
      serviceId: SERVICE.id,
      serviceName: SERVICE.name,
      priceCents: SERVICE.priceCents,
    });
    // Only next Wed's occurrence should survive out of the 1-week window... but
    // a 1-week window from today only contains today's Wed, which is in the
    // past at 07:00 -> zero visits.
    expect(visits).toHaveLength(0);
  });

  it('is empty when weeklyDays is empty or weeks < 1', () => {
    expect(buildWeeklyVisits({ nowMs: NOW, weeklyDays: new Set(), weeks: 4, time: { hour: 9, minute: 0 }, serviceId: 's1', serviceName: 'x', priceCents: null })).toEqual([]);
    expect(buildWeeklyVisits({ nowMs: NOW, weeklyDays: new Set([1]), weeks: 0, time: { hour: 9, minute: 0 }, serviceId: 's1', serviceName: 'x', priceCents: null })).toEqual([]);
  });

  // F35/F36 regression: the wizard must show the kinfolk on Step 3/Review
  // EXACTLY the count that gets submitted, never a re-derived number that
  // could drift (e.g. from a second, slightly-later `Date.now()` read).
  it('is deterministic for a fixed nowMs: repeated calls with identical inputs return identical arrays', () => {
    const params = {
      nowMs: NOW,
      weeklyDays: new Set([0, 2, 4]),
      weeks: 6,
      time: { hour: 9, minute: 0 },
      serviceId: 's1',
      serviceName: 'Daily Visit',
      priceCents: 4200,
    };
    const first = buildWeeklyVisits(params);
    const second = buildWeeklyVisits(params);
    expect(second).toEqual(first);
    // This is the invariant the wizard leans on: compute weeklyPreview ONCE
    // per (pattern, weeklyDays, weekCount, visitTime, serviceId) and reuse
    // the same array for the Step 3 count, the Review count, and the
    // requestBooking payload, rather than recomputing at each site.
    expect(first.length).toBe(weeklyPotentialCount(params.weeklyDays, params.weeks));
  });

  it('caps at MAX_RECURRING_VISITS instead of silently returning everything requested', () => {
    // All 7 weekdays x 10 weeks = 70 potential occurrences, far past the cap.
    const weeklyDays = new Set([0, 1, 2, 3, 4, 5, 6]);
    const weeks = 10;
    const visits = buildWeeklyVisits({
      nowMs: NOW,
      weeklyDays,
      weeks,
      time: { hour: 9, minute: 0 },
      serviceId: 's1',
      serviceName: 'Daily Visit',
      priceCents: 4200,
    });
    expect(visits.length).toBeLessThanOrEqual(MAX_RECURRING_VISITS);
    expect(visits.length).toBe(MAX_RECURRING_VISITS);
    // The potential count is knowably larger, so a caller can detect + warn
    // about truncation instead of it being silent.
    const potential = weeklyPotentialCount(weeklyDays, weeks);
    expect(potential).toBeGreaterThan(visits.length);
  });

  it('MAX_RECURRING_VISITS is 26 (Kotlin RecurringBooking.kt source of truth)', () => {
    expect(MAX_RECURRING_VISITS).toBe(26);
  });
});

describe('buildVisits (individual pattern)', () => {
  it('maps each tapped date to a visit at the chosen time', () => {
    const dates = [new Date(2026, 6, 20), new Date(2026, 6, 22)];
    const visits = buildVisits(dates, '10:30', SERVICE);
    expect(visits).toHaveLength(2);
    expect(new Date(visits[0]!.startTimeMs).getHours()).toBe(10);
    expect(new Date(visits[0]!.startTimeMs).getMinutes()).toBe(30);
    expect(visits[0]!.priceCents).toBe(1500);
  });

  it('falls back to priceMinCents when priceCents is null', () => {
    const visits = buildVisits([new Date(2026, 6, 20)], '09:00', { id: 's2', name: 'Ranged', priceCents: null, priceMinCents: 800 });
    expect(visits[0]!.priceCents).toBe(800);
  });

  it('throws on an invalid time (callers must gate on parseHourMinute first)', () => {
    expect(() => buildVisits([new Date(2026, 6, 20)], 'bad', SERVICE)).toThrow('invalid time');
  });
});

describe('monthPickerDays', () => {
  it('returns every real day of the anchor month, in order', () => {
    const days = monthPickerDays(new Date(2026, 6, 15));
    expect(days).toHaveLength(31); // July
    expect(days[0]!.getDate()).toBe(1);
    expect(days[0]!.getMonth()).toBe(6);
    expect(days.at(-1)!.getDate()).toBe(31);
    // Consecutive.
    for (let i = 1; i < days.length; i++) {
      expect(days[i]!.getTime() - days[i - 1]!.getTime()).toBe(86_400_000);
    }
  });

  /**
   * #544 regression. This used to hand back a flat 28 days from the 1st,
   * which silently dropped the 29th-31st of every long month: on the walk
   * that filed the issue, August 2026 offered up to the 28th and stopped.
   */
  it('does not clip a 30- or 31-day month to 28, and handles February', () => {
    expect(monthPickerDays(new Date(2026, 7, 1))).toHaveLength(31); // August
    expect(monthPickerDays(new Date(2026, 8, 1))).toHaveLength(30); // September
    expect(monthPickerDays(new Date(2026, 1, 1))).toHaveLength(28); // Feb 2026
    expect(monthPickerDays(new Date(2028, 1, 1))).toHaveLength(29); // Feb 2028, leap
  });
});

/** #544: the bounds month navigation is allowed to move between. */
describe('booking horizon', () => {
  it('BOOKING_HORIZON_DAYS matches getBusinessClosures MAX_RANGE_DAYS', () => {
    // There is no booking-horizon setting on business_settings, so the bound
    // is the server's own closure-resolution cap. If that cap ever moves,
    // this is the assertion that says so.
    expect(BOOKING_HORIZON_DAYS).toBe(120);
  });

  it('bookingHorizonEnd lands exactly horizonDays after today', () => {
    const today = new Date(2026, 7, 23);
    expect(dateKey(bookingHorizonEnd(today, 120))).toBe('2026-12-21');
    expect(dateKey(bookingHorizonEnd(today, 1))).toBe('2026-08-24');
  });

  it('shiftMonth rolls across a year boundary in both directions', () => {
    expect(dateKey(shiftMonth(new Date(2026, 11, 15), 1))).toBe('2027-01-01');
    expect(dateKey(shiftMonth(new Date(2026, 0, 15), -1))).toBe('2025-12-01');
  });

  it('monthIndex orders months across years', () => {
    expect(monthIndex(new Date(2026, 11, 1))).toBeLessThan(monthIndex(new Date(2027, 0, 1)));
    expect(monthIndex(new Date(2026, 7, 1))).toBe(monthIndex(new Date(2026, 7, 31)));
  });

  it('isBookableDay accepts today through the horizon and refuses either side', () => {
    const today = new Date(2026, 7, 23, 14, 30);
    const end = bookingHorizonEnd(today, 120);
    expect(isBookableDay(new Date(2026, 7, 22), today, end)).toBe(false); // yesterday
    expect(isBookableDay(new Date(2026, 7, 23, 0, 1), today, end)).toBe(true); // today, inclusive
    expect(isBookableDay(new Date(2026, 10, 4), today, end)).toBe(true); // mid-window
    expect(isBookableDay(new Date(2026, 11, 21), today, end)).toBe(true); // horizon day, inclusive
    expect(isBookableDay(new Date(2026, 11, 22), today, end)).toBe(false); // one past
  });
});

describe('dateKey', () => {
  it('formats as zero-padded YYYY-MM-DD', () => {
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('is stable for two Date instances on the same calendar day', () => {
    const a = new Date(2026, 6, 20, 1, 0);
    const b = new Date(2026, 6, 20, 23, 0);
    expect(dateKey(a)).toBe(dateKey(b));
  });
});

describe('priceLabel', () => {
  it('renders a fixed overnight price with the /night suffix', () => {
    expect(priceLabel({ priceCents: 15000, priceMinCents: null, priceMaxCents: null, isOvernight: true })).toBe('$150.00 / night');
  });

  it('renders a fixed non-overnight price with no suffix', () => {
    expect(priceLabel({ priceCents: 4200, priceMinCents: null, priceMaxCents: null, isOvernight: false })).toBe('$42.00');
  });

  it('renders a min-max range', () => {
    expect(priceLabel({ priceCents: null, priceMinCents: 1500, priceMaxCents: 8000, isOvernight: false })).toBe('$15.00 – $80.00');
  });

  it('renders "from $X" for min-only', () => {
    expect(priceLabel({ priceCents: null, priceMinCents: 1500, priceMaxCents: null, isOvernight: false })).toBe('from $15.00');
  });

  it('renders empty string when no price fields are set', () => {
    expect(priceLabel({ priceCents: null, priceMinCents: null, priceMaxCents: null, isOvernight: false })).toBe('');
  });
});
