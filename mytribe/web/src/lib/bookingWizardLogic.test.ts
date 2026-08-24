import { describe, expect, it } from 'vitest';
import {
  BOOKING_HORIZON_DAYS,
  MAX_RECURRING_VISITS,
  bookingHorizonEnd,
  buildVisits,
  buildWeeklyVisits,
  dateKey,
  estimateBookingTotal,
  findTimeBlock,
  formatEstimate,
  initialBookingMode,
  isBookableDay,
  monthIndex,
  monthPickerDays,
  parseHourMinute,
  pastPlannedVisits,
  plannedVisitLine,
  priceLabel,
  renderPlannedVisits,
  shiftMonth,
  slotsBlocker,
  summariseSlots,
  timeBlockLabel,
  weeklyPotentialCount,
  weeklyVisitsBlocker,
} from './bookingWizardLogic';
import type { BookingTiming, KinCareSlot, WizardService } from './bookingWizardLogic';
import type { TimeBlockDto } from '../api/bookingApi';

const SERVICE: WizardService = { id: 's1', name: "Auntie's In", priceCents: 1500, priceMinCents: null };
/** The catalog entry the #546 worked example is priced against: 30 Minute at $25.00. */
const THIRTY_MINUTE: WizardService = { id: '30Minute', name: '30 Minute', priceCents: 2500, priceMinCents: null };
const SIXTY_MINUTE: WizardService = { id: '60Minute', name: '60 Minute', priceCents: 4500, priceMinCents: null };
const RANGED: WizardService = { id: 'ranged', name: 'Ranged', priceCents: null, priceMinCents: 800 };
const UNPRICED: WizardService = { id: 'unpriced', name: 'Unpriced', priceCents: null, priceMinCents: null };
const CATALOG: WizardService[] = [SERVICE, THIRTY_MINUTE, SIXTY_MINUTE, RANGED, UNPRICED];

/** One KinCare of `serviceId` at `time`, booked on the clock. */
function slot(serviceId: string, time: string, n = 1): KinCareSlot {
  return { slotId: `${serviceId}-${n}`, serviceId, time, timeBlockId: null };
}

/** One KinCare of `serviceId` in the named window. Its `time` is deliberately junk: block mode must never read it. */
function blockSlot(serviceId: string, timeBlockId: string, n = 1): KinCareSlot {
  return { slotId: `${serviceId}-${timeBlockId}-${n}`, serviceId, time: 'nonsense', timeBlockId };
}

const MIDDAY: TimeBlockDto = { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', durationMinutes: 240 };
const EVENING: TimeBlockDto = { id: 'evening', label: 'Evening', startTime: '17:00', endTime: '21:00', durationMinutes: 240 };
const BLOCK_TIMING: BookingTiming = { mode: 'TIME_BLOCK', blocks: [MIDDAY, EVENING] };

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

/** #541 + #543: the KinCare list is what a booking day is made of. */
describe('slotsBlocker', () => {
  it('requires at least one KinCare', () => {
    expect(slotsBlocker([])).toBe('Add at least one KinCare Duration.');
  });

  it('requires every KinCare time to parse', () => {
    expect(slotsBlocker([slot('s1', '09:00'), slot('s1', 'bad', 2)])).toBe('Enter every KinCare time as HH:MM.');
  });

  /** #541: two DIFFERENT durations in one day is the whole point, not an error. */
  it('accepts two different durations at the same time', () => {
    expect(slotsBlocker([slot('30Minute', '09:00'), slot('60Minute', '09:00')])).toBeNull();
  });

  /** #543: the same duration twice in a day is fine as long as the times differ. */
  it('accepts the same duration twice at different times', () => {
    expect(slotsBlocker([slot('30Minute', '09:00'), slot('30Minute', '17:00', 2)])).toBeNull();
  });

  it('refuses the same duration at the same time, which is one KinCare asked for twice', () => {
    expect(slotsBlocker([slot('30Minute', '09:00'), slot('30Minute', '09:00', 2)])).toBe(
      'Two KinCares have the same duration at the same time. Change one of the times.',
    );
  });
});

describe('weeklyPotentialCount', () => {
  it('is days x weeks x KinCares', () => {
    expect(weeklyPotentialCount(new Set([1, 3, 5]), 4, 1)).toBe(12);
    expect(weeklyPotentialCount(new Set([1, 3, 5]), 4, 2)).toBe(24);
  });

  it('is 0 for weeks < 1', () => {
    expect(weeklyPotentialCount(new Set([1]), 0, 3)).toBe(0);
  });
});

describe('weeklyVisitsBlocker', () => {
  const ok = [slot('s1', '09:00')];

  it('requires at least one weekday', () => {
    expect(weeklyVisitsBlocker(new Set(), 4, ok)).toBe('Pick at least one day of the week.');
  });

  it('requires weeks >= 1', () => {
    expect(weeklyVisitsBlocker(new Set([1]), 0, ok)).toBe('Choose how many weeks.');
  });

  it('defers the KinCare rules to slotsBlocker', () => {
    expect(weeklyVisitsBlocker(new Set([1]), 4, [])).toBe('Add at least one KinCare Duration.');
    expect(weeklyVisitsBlocker(new Set([1]), 4, [slot('s1', 'bad')])).toBe('Enter every KinCare time as HH:MM.');
  });

  it('is null once all three are satisfied', () => {
    expect(weeklyVisitsBlocker(new Set([1]), 4, ok)).toBeNull();
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
      slots: [slot('s1', '09:00')],
      services: CATALOG,
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

  /** #541 + #543 on the weekly pattern: every KinCare repeats on every chosen day. */
  it('emits one visit PER KinCare on each matching weekday, in time order within the day', () => {
    const visits = buildWeeklyVisits({
      nowMs: NOW,
      weeklyDays: new Set([1, 3]),
      weeks: 2,
      slots: [slot('60Minute', '17:00'), slot('30Minute', '09:00')],
      services: CATALOG,
    });
    // 4 days x 2 KinCares.
    expect(visits).toHaveLength(8);
    // Within Wed Jul 15 the 09:00 comes before the 17:00, even though the
    // slots were handed over the other way round.
    expect(visits.slice(0, 2).map((v) => v.serviceId)).toEqual(['30Minute', '60Minute']);
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
      slots: [slot('s1', '07:00')],
      services: CATALOG,
    });
    // Only next Wed's occurrence should survive out of the 1-week window... but
    // a 1-week window from today only contains today's Wed, which is in the
    // past at 07:00 -> zero visits.
    expect(visits).toHaveLength(0);
  });

  it('is empty when weeklyDays is empty, weeks < 1, or no KinCare is chosen', () => {
    const slots = [slot('s1', '09:00')];
    expect(buildWeeklyVisits({ nowMs: NOW, weeklyDays: new Set(), weeks: 4, slots, services: CATALOG })).toEqual([]);
    expect(buildWeeklyVisits({ nowMs: NOW, weeklyDays: new Set([1]), weeks: 0, slots, services: CATALOG })).toEqual([]);
    expect(buildWeeklyVisits({ nowMs: NOW, weeklyDays: new Set([1]), weeks: 4, slots: [], services: CATALOG })).toEqual([]);
  });

  it('skips a KinCare whose service has left the catalog rather than inventing one', () => {
    const visits = buildWeeklyVisits({
      nowMs: NOW,
      weeklyDays: new Set([1, 3]),
      weeks: 2,
      slots: [slot('s1', '09:00'), slot('deleted-service', '11:00')],
      services: CATALOG,
    });
    expect(visits).toHaveLength(4);
    expect(visits.every((v) => v.serviceId === 's1')).toBe(true);
  });

  // F35/F36 regression: the wizard must show the kinfolk on Step 3/Review
  // EXACTLY the count that gets submitted, never a re-derived number that
  // could drift (e.g. from a second, slightly-later `Date.now()` read).
  it('is deterministic for a fixed nowMs: repeated calls with identical inputs return identical arrays', () => {
    const params = {
      nowMs: NOW,
      weeklyDays: new Set([0, 2, 4]),
      weeks: 6,
      slots: [slot('s1', '09:00')],
      services: CATALOG,
    };
    const first = buildWeeklyVisits(params);
    const second = buildWeeklyVisits(params);
    expect(second).toEqual(first);
    // This is the invariant the wizard leans on: compute plannedVisits ONCE
    // per (pattern, dates, weeklyDays, weekCount, slots) and reuse the same
    // array for the Step 3 count, the estimate, the Review list, and the
    // requestBooking payload, rather than recomputing at each site.
    expect(first.length).toBe(weeklyPotentialCount(params.weeklyDays, params.weeks, params.slots.length));
  });

  it('caps at MAX_RECURRING_VISITS instead of silently returning everything requested', () => {
    // All 7 weekdays x 10 weeks = 70 potential occurrences, far past the cap.
    const weeklyDays = new Set([0, 1, 2, 3, 4, 5, 6]);
    const weeks = 10;
    const visits = buildWeeklyVisits({
      nowMs: NOW,
      weeklyDays,
      weeks,
      slots: [slot('s1', '09:00')],
      services: CATALOG,
    });
    expect(visits.length).toBeLessThanOrEqual(MAX_RECURRING_VISITS);
    expect(visits.length).toBe(MAX_RECURRING_VISITS);
    // The potential count is knowably larger, so a caller can detect + warn
    // about truncation instead of it being silent.
    const potential = weeklyPotentialCount(weeklyDays, weeks, 1);
    expect(potential).toBeGreaterThan(visits.length);
  });

  /** The cap counts VISITS, so more KinCares per day means fewer days survive it. */
  it('applies the cap to visits, not days, and keeps the chronologically earliest run', () => {
    const weeklyDays = new Set([0, 1, 2, 3, 4, 5, 6]);
    const slots = [slot('30Minute', '09:00'), slot('60Minute', '17:00')];
    const visits = buildWeeklyVisits({ nowMs: NOW, weeklyDays, weeks: 10, slots, services: CATALOG });
    expect(visits).toHaveLength(MAX_RECURRING_VISITS);
    expect(weeklyPotentialCount(weeklyDays, 10, slots.length)).toBe(140);
    for (let i = 1; i < visits.length; i++) {
      expect(visits[i]!.startTimeMs).toBeGreaterThan(visits[i - 1]!.startTimeMs);
    }
  });

  it('MAX_RECURRING_VISITS is 26 (Kotlin RecurringBooking.kt source of truth)', () => {
    expect(MAX_RECURRING_VISITS).toBe(26);
  });
});

describe('buildVisits (individual pattern)', () => {
  it('maps each tapped date to a visit at the KinCare time', () => {
    const dates = [new Date(2026, 6, 20), new Date(2026, 6, 22)];
    const visits = buildVisits(dates, [slot('s1', '10:30')], CATALOG);
    expect(visits).toHaveLength(2);
    expect(new Date(visits[0]!.startTimeMs).getHours()).toBe(10);
    expect(new Date(visits[0]!.startTimeMs).getMinutes()).toBe(30);
    expect(visits[0]!.priceCents).toBe(1500);
  });

  /**
   * #541: two different durations. The dates are the same; what a household
   * asked for on each of them is a 30 Minute AND a 60 Minute.
   */
  it('emits one visit per date PER KinCare when the durations differ', () => {
    const dates = [new Date(2026, 6, 20), new Date(2026, 6, 22)];
    const visits = buildVisits(dates, [slot('30Minute', '09:00'), slot('60Minute', '17:00')], CATALOG);
    expect(visits).toHaveLength(4);
    expect(visits.map((v) => v.serviceName)).toEqual(['30 Minute', '60 Minute', '30 Minute', '60 Minute']);
  });

  /** #543: the same duration twice in one day, which is the midday and the evening walk. */
  it('emits two visits on one day for the same duration at two times', () => {
    const visits = buildVisits([new Date(2026, 6, 20)], [slot('30Minute', '09:00'), slot('30Minute', '17:00', 2)], CATALOG);
    expect(visits).toHaveLength(2);
    expect(visits.map((v) => new Date(v.startTimeMs).getHours())).toEqual([9, 17]);
    expect(new Set(visits.map((v) => dateKey(new Date(v.startTimeMs)))).size).toBe(1);
  });

  it('returns visits sorted by start time whatever order the dates and KinCares arrive in', () => {
    const dates = [new Date(2026, 6, 22), new Date(2026, 6, 20)];
    const visits = buildVisits(dates, [slot('60Minute', '17:00'), slot('30Minute', '09:00')], CATALOG);
    for (let i = 1; i < visits.length; i++) {
      expect(visits[i]!.startTimeMs).toBeGreaterThan(visits[i - 1]!.startTimeMs);
    }
  });

  it('falls back to priceMinCents when priceCents is null', () => {
    const visits = buildVisits([new Date(2026, 6, 20)], [slot('ranged', '09:00')], CATALOG);
    expect(visits[0]!.priceCents).toBe(800);
  });

  it('skips a KinCare with an unparseable time rather than throwing mid-plan', () => {
    // The wizard gates Next on slotsBlocker, so this only happens transiently
    // while a time field is being typed into. Dropping the entry keeps the
    // estimate honest for the rest of the plan instead of blanking the screen.
    const visits = buildVisits([new Date(2026, 6, 20)], [slot('s1', 'bad'), slot('30Minute', '09:00')], CATALOG);
    expect(visits).toHaveLength(1);
    expect(visits[0]!.serviceId).toBe('30Minute');
  });
});

/**
 * #546 / #547. The defect both issues describe is one number that never moved:
 * three visits, still $25.00.
 */
describe('estimateBookingTotal', () => {
  const dates = [new Date(2026, 7, 26), new Date(2026, 7, 27), new Date(2026, 7, 28)];

  /** The worked example straight off the walk that filed #546. */
  it('3 visits of a $25.00 KinCare estimate at $75.00', () => {
    const visits = buildVisits(dates, [slot('30Minute', '09:00')], CATALOG);
    expect(visits).toHaveLength(3);
    const e = estimateBookingTotal(visits, CATALOG);
    expect(e).toEqual({ totalCents: 7500, exactVisits: 3, floorVisits: 0, unpricedVisits: 0 });
    expect(formatEstimate(e)).toBe('$75.00');
  });

  it('grows as dates are added and shrinks as they are taken away', () => {
    const one = estimateBookingTotal(buildVisits(dates.slice(0, 1), [slot('30Minute', '09:00')], CATALOG), CATALOG);
    const two = estimateBookingTotal(buildVisits(dates.slice(0, 2), [slot('30Minute', '09:00')], CATALOG), CATALOG);
    expect(formatEstimate(one)).toBe('$25.00');
    expect(formatEstimate(two)).toBe('$50.00');
  });

  /** #541 + #543 priced: 3 days x (one $25.00 and one $45.00) = $210.00. */
  it('adds up a mixed day: two different KinCares across three dates', () => {
    const visits = buildVisits(dates, [slot('30Minute', '09:00'), slot('60Minute', '17:00')], CATALOG);
    expect(visits).toHaveLength(6);
    expect(formatEstimate(estimateBookingTotal(visits, CATALOG))).toBe('$210.00');
  });

  it('adds up the same KinCare twice in a day', () => {
    const visits = buildVisits(dates, [slot('30Minute', '09:00'), slot('30Minute', '17:00', 2)], CATALOG);
    expect(formatEstimate(estimateBookingTotal(visits, CATALOG))).toBe('$150.00');
  });

  it('is an em dash for an empty plan, not $0.00', () => {
    expect(formatEstimate(estimateBookingTotal([], CATALOG))).toBe('—');
  });

  it('says "from" when part of the plan can only be bounded below', () => {
    const visits = buildVisits(dates.slice(0, 1), [slot('30Minute', '09:00'), slot('ranged', '17:00')], CATALOG);
    const e = estimateBookingTotal(visits, CATALOG);
    expect(e.floorVisits).toBe(1);
    expect(formatEstimate(e)).toBe('from $33.00');
  });

  it('says Pending when nothing in the plan carries a price, rather than $0.00', () => {
    const visits = buildVisits(dates, [slot('unpriced', '09:00')], CATALOG);
    const e = estimateBookingTotal(visits, CATALOG);
    expect(e).toEqual({ totalCents: 0, exactVisits: 0, floorVisits: 0, unpricedVisits: 3 });
    expect(formatEstimate(e)).toBe('Pending');
  });
});

/**
 * #547: "Actually display those dates."
 * The spelling is the one in
 * docs/superpowers/specs/2026-08-23-visit-date-rendering-design.md — enumerate,
 * never summarise, with each visit as weekday / date / time.
 */
describe('renderPlannedVisits', () => {
  it('renders each visit as the spec spells it, oldest first', () => {
    const visits = buildVisits(
      [new Date(2026, 8, 6), new Date(2026, 8, 4)],
      [slot('30Minute', '09:00')],
      CATALOG,
    );
    const rendered = renderPlannedVisits(visits);
    expect(rendered.map(plannedVisitLine)).toEqual(['Fri, Sep 4 at 9:00 AM', 'Sun, Sep 6 at 9:00 AM']);
    expect(rendered[0]).toMatchObject({ weekday: 'Fri', date: 'Sep 4', time: '9:00 AM', serviceName: '30 Minute' });
  });

  it('enumerates every visit of a two-KinCare day instead of collapsing it to a count', () => {
    const visits = buildVisits([new Date(2026, 8, 4)], [slot('30Minute', '09:00'), slot('60Minute', '17:30')], CATALOG);
    expect(renderPlannedVisits(visits).map(plannedVisitLine)).toEqual([
      'Fri, Sep 4 at 9:00 AM',
      'Fri, Sep 4 at 5:30 PM',
    ]);
  });

  it('gives each visit of a day a distinct key', () => {
    const visits = buildVisits([new Date(2026, 8, 4)], [slot('30Minute', '09:00'), slot('30Minute', '17:00', 2)], CATALOG);
    const keys = renderPlannedVisits(visits).map((v) => v.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('renders midnight as 12:00 AM and noon as 12:00 PM', () => {
    const visits = buildVisits([new Date(2026, 8, 4)], [slot('30Minute', '00:00'), slot('60Minute', '12:00')], CATALOG);
    expect(renderPlannedVisits(visits).map((v) => v.time)).toEqual(['12:00 AM', '12:00 PM']);
  });
});

describe('summariseSlots', () => {
  it('counts repeats rather than repeating the name', () => {
    const slots = [slot('30Minute', '09:00'), slot('30Minute', '17:00', 2), slot('60Minute', '12:00')];
    expect(summariseSlots(slots, CATALOG)).toBe('2 × 30 Minute, 60 Minute');
  });

  it('is empty for an empty list', () => {
    expect(summariseSlots([], CATALOG)).toBe('');
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

/**
 * Time-block booking, client half. Operator requirement 2026-08-24: "kinfolk
 * book within time blocks, not at a specific set time."
 *
 * The mode is booking-level and the window is per-KinCare, so these pin the two
 * things that follow from that: a visit's start comes from its window (never
 * from the clock field, which block mode must not read at all), and the
 * duplicate rule counts a visit as (KinCare, block) rather than
 * (KinCare, instant) — otherwise two durations in one window, which is exactly
 * what #541/#543 built, would look like one KinCare asked for twice.
 */
describe('initialBookingMode', () => {
  it('opens on the business default when both modes are allowed', () => {
    expect(
      initialBookingMode({ allowTimeBlockBooking: true, allowSpecificTimeBooking: true, defaultBookingMode: 'TIME_BLOCK' }),
    ).toBe('TIME_BLOCK');
    expect(
      initialBookingMode({ allowTimeBlockBooking: true, allowSpecificTimeBooking: true, defaultBookingMode: 'SPECIFIC_TIME' }),
    ).toBe('SPECIFIC_TIME');
  });

  it('opens on the only allowed mode, whatever the stored default says', () => {
    expect(
      initialBookingMode({ allowTimeBlockBooking: true, allowSpecificTimeBooking: false, defaultBookingMode: 'SPECIFIC_TIME' }),
    ).toBe('TIME_BLOCK');
    expect(
      initialBookingMode({ allowTimeBlockBooking: false, allowSpecificTimeBooking: true, defaultBookingMode: 'TIME_BLOCK' }),
    ).toBe('SPECIFIC_TIME');
  });
});

describe('findTimeBlock / timeBlockLabel', () => {
  it('finds a window by id and names it with its hours', () => {
    expect(findTimeBlock([MIDDAY, EVENING], 'evening')).toBe(EVENING);
    expect(findTimeBlock([MIDDAY, EVENING], 'brunch')).toBeNull();
    expect(findTimeBlock([MIDDAY, EVENING], null)).toBeNull();
    expect(timeBlockLabel(MIDDAY)).toBe('Midday (11:00 – 15:00)');
  });
});

describe('slotsBlocker in block mode', () => {
  it('asks for a window when a KinCare has none', () => {
    expect(slotsBlocker([{ slotId: 'a', serviceId: '30Minute', time: '09:00', timeBlockId: null }], BLOCK_TIMING)).toBe(
      'Choose a time block for every KinCare.',
    );
  });

  it('asks for a window when the one on the slot is gone from the catalog', () => {
    expect(slotsBlocker([blockSlot('30Minute', 'brunch')], BLOCK_TIMING)).toBe('Choose a time block for every KinCare.');
  });

  it('accepts two DIFFERENT durations in the same window', () => {
    expect(slotsBlocker([blockSlot('30Minute', 'midday'), blockSlot('60Minute', 'midday')], BLOCK_TIMING)).toBeNull();
  });

  it('accepts the same duration in two different windows', () => {
    expect(slotsBlocker([blockSlot('30Minute', 'midday'), blockSlot('30Minute', 'evening')], BLOCK_TIMING)).toBeNull();
  });

  it('refuses the same duration in the same window twice, in block words', () => {
    expect(slotsBlocker([blockSlot('30Minute', 'midday'), blockSlot('30Minute', 'midday', 2)], BLOCK_TIMING)).toBe(
      'Two KinCares are the same duration in the same time block. Remove one, or move it to another block.',
    );
  });

  it('never reads the clock field in block mode', () => {
    // Both slots carry the junk time `blockSlot` sets, which would fail the
    // HH:MM check that governs specific-time mode.
    expect(slotsBlocker([blockSlot('30Minute', 'midday')], BLOCK_TIMING)).toBeNull();
    expect(slotsBlocker([blockSlot('30Minute', 'midday')])).toBe('Enter every KinCare time as HH:MM.');
  });
});

describe('buildVisits in block mode', () => {
  it('starts each visit at its window and stamps the block id on it', () => {
    const visits = buildVisits([new Date(2026, 8, 4)], [blockSlot('30Minute', 'midday')], CATALOG, BLOCK_TIMING);
    expect(visits).toHaveLength(1);
    expect(new Date(visits[0]!.startTimeMs).getHours()).toBe(11);
    expect(new Date(visits[0]!.startTimeMs).getMinutes()).toBe(0);
    expect(visits[0]!.timeBlockId).toBe('midday');
  });

  it('prices a block-booked visit from the KinCare, exactly as a clock-booked one', () => {
    const [blockVisit] = buildVisits([new Date(2026, 8, 4)], [blockSlot('30Minute', 'midday')], CATALOG, BLOCK_TIMING);
    const [clockVisit] = buildVisits([new Date(2026, 8, 4)], [slot('30Minute', '11:00')], CATALOG);
    expect(blockVisit!.priceCents).toBe(2500);
    expect(blockVisit!.priceCents).toBe(clockVisit!.priceCents);
    expect(estimateBookingTotal([blockVisit!], CATALOG)).toEqual(
      estimateBookingTotal([clockVisit!], CATALOG),
    );
  });

  it('emits two visits for two durations in one window, both at the same instant', () => {
    const visits = buildVisits(
      [new Date(2026, 8, 4)],
      [blockSlot('30Minute', 'midday'), blockSlot('60Minute', 'midday')],
      CATALOG,
      BLOCK_TIMING,
    );
    expect(visits).toHaveLength(2);
    expect(new Set(visits.map((v) => v.startTimeMs)).size).toBe(1);
    expect(visits.map((v) => v.serviceId)).toEqual(['30Minute', '60Minute']);
  });

  it('drops a KinCare whose window is gone rather than inventing a time for it', () => {
    expect(buildVisits([new Date(2026, 8, 4)], [blockSlot('30Minute', 'brunch')], CATALOG, BLOCK_TIMING)).toEqual([]);
  });

  it('leaves timeBlockId null on every clock-booked visit', () => {
    const visits = buildVisits([new Date(2026, 8, 4)], [slot('30Minute', '09:00')], CATALOG);
    expect(visits[0]!.timeBlockId).toBeNull();
  });
});

describe('buildWeeklyVisits in block mode', () => {
  it('expands a weekly rule onto the window start, block id intact', () => {
    // A Friday, 08:00 local, so the same day's 11:00 window is still ahead.
    const nowMs = new Date(2026, 8, 4, 8, 0).getTime();
    const visits = buildWeeklyVisits({
      nowMs,
      weeklyDays: new Set([5]),
      weeks: 2,
      slots: [blockSlot('30Minute', 'midday')],
      services: CATALOG,
      timing: BLOCK_TIMING,
    });
    expect(visits).toHaveLength(2);
    expect(visits.every((v) => v.timeBlockId === 'midday')).toBe(true);
    expect(visits.every((v) => new Date(v.startTimeMs).getHours() === 11)).toBe(true);
  });

  it('still drops an occurrence whose window has already opened today', () => {
    // 14:00 on the Friday: today's Midday visit is in the past, next week's is not.
    const nowMs = new Date(2026, 8, 4, 14, 0).getTime();
    const visits = buildWeeklyVisits({
      nowMs,
      weeklyDays: new Set([5]),
      weeks: 2,
      slots: [blockSlot('30Minute', 'midday')],
      services: CATALOG,
      timing: BLOCK_TIMING,
    });
    expect(visits).toHaveLength(1);
    expect(dateKey(new Date(visits[0]!.startTimeMs))).toBe('2026-09-11');
  });
});

describe('pastPlannedVisits', () => {
  it('names the visits the server would refuse for starting in the past', () => {
    const nowMs = new Date(2026, 8, 4, 14, 0).getTime();
    const visits = buildVisits(
      [new Date(2026, 8, 4)],
      [blockSlot('30Minute', 'midday'), blockSlot('60Minute', 'evening')],
      CATALOG,
      BLOCK_TIMING,
    );
    // Midday opened at 11:00 and it is 14:00; Evening opens at 17:00.
    const past = pastPlannedVisits(visits, nowMs);
    expect(past).toHaveLength(1);
    expect(past[0]!.timeBlockId).toBe('midday');
  });

  it('is empty for a plan entirely in the future', () => {
    const nowMs = new Date(2026, 8, 4, 8, 0).getTime();
    const visits = buildVisits([new Date(2026, 8, 4)], [blockSlot('30Minute', 'midday')], CATALOG, BLOCK_TIMING);
    expect(pastPlannedVisits(visits, nowMs)).toEqual([]);
  });
});

describe('renderPlannedVisits with blocks', () => {
  it('names the window instead of reporting a precision the household never gave', () => {
    const visits = buildVisits([new Date(2026, 8, 4)], [blockSlot('30Minute', 'midday')], CATALOG, BLOCK_TIMING);
    const rendered = renderPlannedVisits(visits, [MIDDAY, EVENING]);
    expect(rendered[0]!.timeBlockLabel).toBe('Midday (11:00 – 15:00)');
    expect(plannedVisitLine(rendered[0]!)).toBe('Fri, Sep 4 · Midday (11:00 – 15:00)');
  });

  it('still spells a clock-booked visit the way the spec does', () => {
    const visits = buildVisits([new Date(2026, 8, 4)], [slot('30Minute', '09:00')], CATALOG);
    const rendered = renderPlannedVisits(visits, [MIDDAY, EVENING]);
    expect(rendered[0]!.timeBlockLabel).toBeNull();
    expect(plannedVisitLine(rendered[0]!)).toBe('Fri, Sep 4 at 9:00 AM');
  });

  it('gives two durations in one window distinct keys, though their instants are equal', () => {
    const visits = buildVisits(
      [new Date(2026, 8, 4)],
      [blockSlot('30Minute', 'midday'), blockSlot('60Minute', 'midday')],
      CATALOG,
      BLOCK_TIMING,
    );
    const keys = renderPlannedVisits(visits, [MIDDAY]).map((v) => v.key);
    expect(new Set(keys).size).toBe(2);
  });
});
