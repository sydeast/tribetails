/**
 * Pure booking-wizard date/pattern logic, ported line-for-line from the
 * Kotlin reference so web and the Compose app compute the exact same
 * dates from the exact same inputs:
 *   - src/commonMain/kotlin/com/kinfolk/portal/screens/schedule/RecurringBooking.kt
 *     (MAX_RECURRING_VISITS, parseHourMinuteOrNull, weeklyPotentialCount,
 *     weeklyVisitsBlocker, buildWeeklyVisits)
 *   - src/commonMain/kotlin/com/kinfolk/portal/screens/schedule/BookingWizardScreen.kt
 *     (parseHourMinute, buildVisits, priceLabel, SimpleMonthPicker's day range)
 *
 * This is the SINGLE SOURCE OF TRUTH the wizard screen reuses for the Step 3
 * preview count, the Step 5 review, and the submit payload: the same
 * "compute once, reuse everywhere" shape as the Kotlin `weeklyPreview`
 * `remember(...)` block, which is what fixes F35/F36 by construction: the
 * number a kinfolk confirms on Review is never allowed to drift from what
 * gets sent to `requestBooking`, because both read the same array reference.
 *
 * Kept dependency-free (no React) so it is trivially unit-testable and safe
 * to reuse from any future callsite (e.g. a recurring-visit editor).
 *
 * #541 / #543 changed the shape everything below is built on: a booking day is
 * a LIST of KinCares ({@link KinCareSlot}), not one service and one time. Every
 * signature that used to take `(time, service)` now takes `(slots, services)`,
 * and the Kotlin side moved with it in the same commit — RecurringBooking.kt
 * carries the identical `KinCareSlot`, `slotsBlocker`, `buildWeeklyVisits` and
 * `estimateBookingTotal`, so the two platforms still compute the same visits
 * and the same money from the same inputs.
 */
import type { ServiceDto } from '../api/bookingApi';
import type { RequestBookingArgsVisit } from '../contracts/bookingContracts.generated';
import { formatUsd } from './invoiceFormat';

/** Hard cap so a runaway weekly rule can never create a huge batch. Mirrors RecurringBooking.kt's MAX_RECURRING_VISITS. */
export const MAX_RECURRING_VISITS = 26;

export interface HourMinute {
  hour: number;
  minute: number;
}

/**
 * Parses "HH:MM" to hour/minute, or null. Mirrors RecurringBooking.kt's
 * `parseHourMinuteOrNull` (trims each part, requires exactly 2 integer
 * parts, hour 0-23, minute 0-59).
 */
export function parseHourMinute(raw: string): HourMinute | null {
  const parts = raw.split(':');
  if (parts.length !== 2) return null;
  const hourPart = parts[0]?.trim() ?? '';
  const minutePart = parts[1]?.trim() ?? '';
  if (!/^\d+$/.test(hourPart) || !/^\d+$/.test(minutePart)) return null;
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** The catalog fields every function below needs off a `ServiceDto`. */
export type WizardService = Pick<ServiceDto, 'id' | 'name' | 'priceCents' | 'priceMinCents'>;

/**
 * #541 + #543: ONE KinCare inside a booking day.
 *
 * The wizard used to carry `selectedServiceId: string | null` plus a single
 * `visitTime`, which is exactly two visits it could not express: two DIFFERENT
 * durations (#541, "a 30 minute in the morning and a 60 minute after work"),
 * and two KinCares of the SAME duration on one day (#543, the midday and the
 * evening walk). Both of those are one shape, not two: a booking day is a LIST
 * of KinCares, and the thing that separates two entries with the same duration
 * is the time of day. So a slot carries its own time, and the plan is
 * `dates x slots`.
 *
 * `slotId` exists only so React (and the Compose `key`) can tell two otherwise
 * identical rows apart while one of them is being edited. It is never sent.
 */
export interface KinCareSlot {
  slotId: string;
  serviceId: string;
  /** 'HH:MM', local to the household. */
  time: string;
}

/** Chronological, so the plan a household reads runs down the day. Ties broken by service for determinism. */
function compareSlots(a: KinCareSlot, b: KinCareSlot): number {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  return a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0;
}

/**
 * First blocking reason for the KinCare list, or null when it is sendable.
 *
 * The duplicate rule is the one worth reading twice: two slots with the same
 * duration AND the same time are not "two KinCares in a day", they are one
 * KinCare requested twice, and the server refuses them (`requestBooking`'s
 * duplicate guard). Saying so here means a household finds out while they can
 * still fix it, instead of at Create Booking.
 */
export function slotsBlocker(slots: readonly KinCareSlot[]): string | null {
  if (slots.length === 0) return 'Add at least one KinCare Duration.';
  if (slots.some((s) => parseHourMinute(s.time) === null)) return 'Enter every KinCare time as HH:MM.';
  const seen = new Set<string>();
  for (const s of slots) {
    const key = `${s.serviceId}@${s.time}`;
    if (seen.has(key)) return 'Two KinCares have the same duration at the same time. Change one of the times.';
    seen.add(key);
  }
  return null;
}

/**
 * The number of visits a weekly rule INTENDS to create (days x weeks x
 * KinCares), ignoring the future-only filter + the cap. Used to detect +
 * surface cap truncation so it is never silent. Mirrors
 * `weeklyPotentialCount`.
 */
export function weeklyPotentialCount(weeklyDays: ReadonlySet<number>, weeks: number, slotCount: number): number {
  return weeks < 1 ? 0 : weeklyDays.size * weeks * slotCount;
}

/** First blocking reason for a weekly rule, or null when it is sendable. Mirrors `weeklyVisitsBlocker`. */
export function weeklyVisitsBlocker(
  weeklyDays: ReadonlySet<number>,
  weeks: number,
  slots: readonly KinCareSlot[],
): string | null {
  if (weeklyDays.size === 0) return 'Pick at least one day of the week.';
  if (weeks < 1) return 'Choose how many weeks.';
  return slotsBlocker(slots);
}

/** Builds one visit for `slot` on the calendar day `d`, or null when the slot's service is gone from the catalog. */
function slotVisitOn(d: Date, slot: KinCareSlot, services: readonly WizardService[]): RequestBookingArgsVisit | null {
  const service = services.find((s) => s.id === slot.serviceId);
  if (!service) return null;
  const t = parseHourMinute(slot.time);
  if (t === null) return null;
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.hour, t.minute);
  return {
    startTimeMs: dt.getTime(),
    endTimeMs: null,
    serviceId: service.id,
    serviceName: service.name,
    priceCents: service.priceCents ?? service.priceMinCents,
  };
}

export interface BuildWeeklyVisitsParams {
  nowMs: number;
  weeklyDays: ReadonlySet<number>;
  weeks: number;
  slots: readonly KinCareSlot[];
  services: readonly WizardService[];
}

/**
 * Expands a weekly rule into concrete future visits. Walks each calendar day
 * from "now" (in the browser's local timezone, same as
 * `TimeZone.currentSystemDefault()`) for `weeks` weeks, emitting ONE VISIT PER
 * KinCare SLOT for every day whose weekday is in `weeklyDays` (0=Sun..6=Sat,
 * matching both `Date#getDay()` and the server's `weeklyDays` 0-6) and whose
 * datetime is strictly in the future (so the server's past-start rejection
 * never trips). Capped at MAX_RECURRING_VISITS. Mirrors `buildWeeklyVisits`.
 *
 * The cap counts VISITS, not days: three KinCares a day for four weeks of
 * Mondays is 12 visits, and it is the 26 visits that would hurt the batch, not
 * the days. Slots are walked in time order inside each day so the run that
 * survives the cap is the chronologically earliest one, never an arbitrary
 * slice of the middle.
 */
export function buildWeeklyVisits(params: BuildWeeklyVisitsParams): RequestBookingArgsVisit[] {
  const { nowMs, weeklyDays, weeks, slots, services } = params;
  if (weeklyDays.size === 0 || weeks < 1 || slots.length === 0) return [];

  const ordered = [...slots].sort(compareSlots);
  const now = new Date(nowMs);
  const startYear = now.getFullYear();
  const startMonth = now.getMonth();
  const startDate = now.getDate();

  const out: RequestBookingArgsVisit[] = [];
  const totalDays = weeks * 7;
  let offset = 0;
  while (offset < totalDays && out.length < MAX_RECURRING_VISITS) {
    const d = new Date(startYear, startMonth, startDate + offset);
    if (weeklyDays.has(d.getDay())) {
      for (const slot of ordered) {
        if (out.length >= MAX_RECURRING_VISITS) break;
        const visit = slotVisitOn(d, slot, services);
        if (visit !== null && visit.startTimeMs > nowMs) out.push(visit);
      }
    }
    offset++;
  }
  return out;
}

/**
 * Expands the Individual-pattern tapped dates into visits: one per date PER
 * KinCare SLOT, each at its own slot time. Mirrors BookingWizardScreen.kt's
 * `buildVisits`.
 *
 * Returns the visits sorted by start time, which is both what a household
 * reads on Review and the order the envelope's `firstStartTime` /
 * `lastStartTime` rollup wants.
 */
export function buildVisits(
  dates: readonly Date[],
  slots: readonly KinCareSlot[],
  services: readonly WizardService[],
): RequestBookingArgsVisit[] {
  const out: RequestBookingArgsVisit[] = [];
  for (const d of dates) {
    for (const slot of slots) {
      const visit = slotVisitOn(d, slot, services);
      if (visit !== null) out.push(visit);
    }
  }
  return out.sort((a, b) => a.startTimeMs - b.startTimeMs || a.serviceId.localeCompare(b.serviceId));
}

/**
 * #546 / #547: what a booking is estimated to cost, computed from the ACTUAL
 * visit list.
 *
 * The old estimate was `priceLabel(selectedService)` — the catalog's per-visit
 * sticker price, printed unchanged next to a plan of three visits. It could
 * not go wrong, because it never read the plan at all: it said $25.00 whether
 * the household had picked no dates, one date, or three. That is the whole of
 * #546, and #547's "price still didn't update" is the same string on the
 * Review step.
 *
 * So the total is derived HERE, from the visits, and both surfaces call this
 * one function. A price that cannot be known is counted, never guessed:
 *   - `floorVisits`   the service is range-priced, so its `priceMinCents` is a
 *                     floor and the total is a "from".
 *   - `unpricedVisits` the service carries no price at all; it contributes
 *                     nothing and forces the "from" too.
 */
export interface BookingEstimate {
  /** Sum of every KNOWN per-visit price, in cents. */
  totalCents: number;
  /** Visits whose service has a fixed price: the total is exact for these. */
  exactVisits: number;
  /** Visits priced from a range minimum: their real price can only be higher. */
  floorVisits: number;
  /** Visits whose service carries no price at all. They add 0. */
  unpricedVisits: number;
}

export function estimateBookingTotal(
  visits: readonly RequestBookingArgsVisit[],
  services: readonly WizardService[],
): BookingEstimate {
  let totalCents = 0;
  let exactVisits = 0;
  let floorVisits = 0;
  let unpricedVisits = 0;
  for (const v of visits) {
    const service = services.find((s) => s.id === v.serviceId);
    const fixed = service?.priceCents ?? null;
    const floor = service?.priceMinCents ?? null;
    if (fixed !== null) {
      totalCents += fixed;
      exactVisits++;
    } else if (floor !== null) {
      totalCents += floor;
      floorVisits++;
    } else {
      unpricedVisits++;
    }
  }
  return { totalCents, exactVisits, floorVisits, unpricedVisits };
}

/**
 * The estimate as a household reads it: '$75.00', 'from $75.00' when part of
 * the plan can only be bounded below, 'Pending' when nothing in it is priced,
 * and an em dash for an empty plan. Never invents a number.
 */
export function formatEstimate(e: BookingEstimate): string {
  const total = e.exactVisits + e.floorVisits + e.unpricedVisits;
  if (total === 0) return '—';
  if (e.exactVisits === 0 && e.floorVisits === 0) return 'Pending';
  const money = formatUsd(e.totalCents / 100);
  return e.floorVisits > 0 || e.unpricedVisits > 0 ? `from ${money}` : money;
}

/** One planned visit, formatted for a kinfolk-facing list. See {@link renderPlannedVisits}. */
export interface RenderedPlannedVisit {
  /** 'Thu' */
  weekday: string;
  /** 'Sep 4' */
  date: string;
  /** '9:00 AM' */
  time: string;
  serviceName: string;
  /** Stable list key: two KinCares of the same duration on one day differ by time. */
  key: string;
}

/**
 * #547: the chosen dates, ENUMERATED.
 *
 * Review used to print "3 visits" and stop, which is precisely the summarising
 * `docs/superpowers/specs/2026-08-23-visit-date-rendering-design.md` rules out:
 * a count says nothing about WHICH days, and four Thursdays across a month read
 * as a four-day block. The spelling below is the spec's own — `weekday`,
 * `date`, `time` as 'Thu', 'Sep 4', '9:00 AM' — so the wizard and the messages
 * a household later receives name the same day the same way.
 *
 * ONE DELIBERATE DIFFERENCE, and it is a difference the spec does not cover:
 * the spec formats server-side in `business_settings.timeZone`, because a
 * message is composed for a recipient who is not there. This list is rendered
 * in the browser's own zone, from dates the household just tapped on their own
 * calendar — formatting those in the business's zone could show them a day they
 * did not pick. The spec governs messages; this is the wizard.
 */
export function renderPlannedVisits(visits: readonly RequestBookingArgsVisit[]): RenderedPlannedVisit[] {
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  return [...visits]
    .sort((a, b) => a.startTimeMs - b.startTimeMs)
    .map((v) => {
      const d = new Date(v.startTimeMs);
      return {
        weekday: weekdayFmt.format(d),
        date: dateFmt.format(d),
        time: timeFmt.format(d),
        serviceName: v.serviceName,
        key: `${v.startTimeMs}-${v.serviceId}`,
      };
    });
}

/** 'Thu, Sep 4 at 9:00 AM' — the spec's own one-line spelling of a visit. */
export function plannedVisitLine(v: RenderedPlannedVisit): string {
  return `${v.weekday}, ${v.date} at ${v.time}`;
}

/**
 * The KinCare list as the summary rail says it: '2 × 30 Minute, 1 × 60 Minute',
 * counted rather than repeated, in the order the durations were first added.
 */
export function summariseSlots(slots: readonly KinCareSlot[], services: readonly WizardService[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const s of slots) {
    if (!counts.has(s.serviceId)) order.push(s.serviceId);
    counts.set(s.serviceId, (counts.get(s.serviceId) ?? 0) + 1);
  }
  return order
    .map((id) => {
      const name = services.find((s) => s.id === id)?.name ?? id;
      const n = counts.get(id) ?? 0;
      return n > 1 ? `${n} × ${name}` : name;
    })
    .join(', ');
}

/**
 * #544: how far ahead the Individual-pattern picker lets a household book.
 *
 * There is NO booking-horizon field on the `business_settings` doc (checked
 * the whole `BusinessSettings` model in AuntieOS's FirestoreClient.kt: it
 * carries hours, holidays, time blocks, travel buffer, ETA and retention
 * windows, and nothing horizon-shaped), so rather than invent an operator
 * setting nobody can see or edit, the bound is the one real limit the server
 * already imposes on this flow: `getBusinessClosures`'s `MAX_RANGE_DAYS`
 * (120). That is the furthest out the portal can find out whether a date is
 * closed, and offering a date whose closure status we cannot resolve is
 * exactly the "picker that looks authoritative about a day it cannot book"
 * that callable exists to prevent. When a real horizon setting is added,
 * this constant is the single place the picker reads it from.
 */
export const BOOKING_HORIZON_DAYS = 120;

/** Midnight-local copy of `d`, so day comparisons ignore the time of day. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The last (inclusive) date a booking may be placed on, counting from `today`. */
export function bookingHorizonEnd(today: Date, horizonDays: number = BOOKING_HORIZON_DAYS): Date {
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + horizonDays);
}

/** Months-since-year-0 ordinal, so two dates' months compare with `<`/`>`. */
export function monthIndex(d: Date): number {
  return d.getFullYear() * 12 + d.getMonth();
}

/** The 1st of the month `delta` months away from `anchor` (negative goes back). */
export function shiftMonth(anchor: Date, delta: number): Date {
  return new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1);
}

/**
 * Every real calendar day in `anchor`'s month — 28, 29, 30 or 31 of them.
 *
 * #544: this used to hand back a flat 28 days counted from the 1st, ported
 * from the Kotlin `SimpleMonthPicker`'s `daysToShow` for date-set parity.
 * With the picker pinned to the current month that quietly ate the 29th
 * through 31st of every long month; once the picker can page forward it is
 * simply wrong. Both platforms moved to real months together — the Kotlin
 * side now reads its days from `bookingMonthDays` in BookingCalendar.kt.
 */
export function monthPickerDays(anchor: Date): Date[] {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  // Day 0 of the next month is the last day of this one.
  const length = new Date(year, month + 1, 0).getDate();
  return Array.from({ length }, (_, i) => new Date(year, month, i + 1));
}

/**
 * Whether `day` may be booked: today or later (a past date is refused by
 * `requestBooking` server-side anyway) and no later than the horizon.
 */
export function isBookableDay(day: Date, today: Date, horizonEnd: Date): boolean {
  const d = startOfDay(day).getTime();
  return d >= startOfDay(today).getTime() && d <= startOfDay(horizonEnd).getTime();
}

/** Stable "YYYY-MM-DD" key for a local calendar date, used for Set membership + React keys. */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "$42 / night" / "$15 – $80" / "from $15" / "" (mirrors BookingWizardScreen.kt's `priceLabel`, en dash included: matches the Kotlin range separator for platform parity). */
export function priceLabel(s: Pick<ServiceDto, 'priceCents' | 'priceMinCents' | 'priceMaxCents' | 'isOvernight'>): string {
  const { priceCents: p, priceMinCents: min, priceMaxCents: max } = s;
  if (p !== null) return `${formatUsd(p / 100)}${s.isOvernight ? ' / night' : ''}`;
  if (min !== null && max !== null) return `${formatUsd(min / 100)} – ${formatUsd(max / 100)}`;
  if (min !== null) return `from ${formatUsd(min / 100)}`;
  return '';
}

