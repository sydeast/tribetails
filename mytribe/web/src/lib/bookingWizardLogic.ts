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
import type { BookingMode, GetBookingPolicyResult, ServiceDto, TimeBlockDto } from '../api/bookingApi';
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
  /** 'HH:MM', local to the household. Read in SPECIFIC_TIME mode. */
  time: string;
  /**
   * Time-block booking: the named window this KinCare was asked for. Read in
   * TIME_BLOCK mode; null there means the household has not chosen one yet.
   *
   * BOTH fields live on the slot at once, deliberately. The MODE is a
   * booking-level choice (see {@link BookingTiming}) — an operator asked for
   * blocks instead of clocks, not for a per-KinCare mixture — so switching mode
   * must not discard what was already typed on the other control. What the
   * server receives is decided by the mode, never by which field happens to be
   * set.
   */
  timeBlockId: string | null;
}

/**
 * Time-block booking, client half. Operator requirement 2026-08-24: "kinfolk
 * book within time blocks, not at a specific set time."
 *
 * The MODE is booking-level and the BLOCK is per-KinCare, which is the shape
 * the requirement actually has: a day may hold several KinCares (#541/#543), so
 * a household may want the 30-minute one in the Midday block and the 60-minute
 * one in the Evening block, or two different KinCares in the same block. What
 * it never wants is one KinCare on the clock and the next one in a window.
 */
export interface BookingTiming {
  mode: BookingMode;
  /** The windows on offer. Empty in SPECIFIC_TIME mode, and never empty in TIME_BLOCK mode. */
  blocks: readonly TimeBlockDto[];
}

/** The pre-time-block world: clock times, no windows. The default every existing caller gets. */
export const SPECIFIC_TIME_ONLY: BookingTiming = { mode: 'SPECIFIC_TIME', blocks: [] };

/**
 * Which mode the wizard opens on, and which the household may switch to.
 *
 * Reads the SERVER-NORMALIZED policy and nothing else: `getBookingPolicy`
 * already resolved "block booking on but no usable window" down to block
 * booking off, and "neither mode allowed" down to specific time, so there is no
 * combination left here that renders an empty screen. The one job left is
 * picking the opening mode, and honouring `defaultBookingMode` when it is
 * available.
 */
export function initialBookingMode(policy: Pick<GetBookingPolicyResult, 'allowTimeBlockBooking' | 'allowSpecificTimeBooking' | 'defaultBookingMode'>): BookingMode {
  if (!policy.allowTimeBlockBooking) return 'SPECIFIC_TIME';
  if (!policy.allowSpecificTimeBooking) return 'TIME_BLOCK';
  return policy.defaultBookingMode;
}

/** The window with this id, or null. */
export function findTimeBlock(blocks: readonly TimeBlockDto[], id: string | null): TimeBlockDto | null {
  if (id === null) return null;
  return blocks.find((b) => b.id === id) ?? null;
}

/** 'Midday (11:00 – 15:00)' — how a window is named wherever one is chosen or confirmed. */
export function timeBlockLabel(block: TimeBlockDto): string {
  return `${block.label} (${block.startTime} – ${block.endTime})`;
}

/**
 * The 'HH:MM' a slot actually starts at, under `timing`, or null when it has
 * nothing usable yet.
 *
 * In TIME_BLOCK mode a visit starts at its window's FIRST MINUTE. That is not a
 * pretence that the Auntie arrives at 11:00 sharp — it is the only instant the
 * whole window is derivable from, it is what AuntieOS's own containment
 * resolver labels back as "Midday block", and the block id travels beside it so
 * the office reads the household's answer rather than inferring it.
 */
function slotStartHHmm(slot: KinCareSlot, timing: BookingTiming): string | null {
  if (timing.mode === 'TIME_BLOCK') {
    return findTimeBlock(timing.blocks, slot.timeBlockId)?.startTime ?? null;
  }
  return parseHourMinute(slot.time) === null ? null : slot.time;
}

/** Chronological, so the plan a household reads runs down the day. Ties broken by service for determinism. */
function compareSlots(a: KinCareSlot, b: KinCareSlot, timing: BookingTiming): number {
  const at = slotStartHHmm(a, timing) ?? '';
  const bt = slotStartHHmm(b, timing) ?? '';
  if (at !== bt) return at < bt ? -1 : 1;
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
export function slotsBlocker(slots: readonly KinCareSlot[], timing: BookingTiming = SPECIFIC_TIME_ONLY): string | null {
  if (slots.length === 0) return 'Add at least one KinCare Duration.';
  if (timing.mode === 'TIME_BLOCK') {
    if (slots.some((s) => findTimeBlock(timing.blocks, s.timeBlockId) === null)) {
      return 'Choose a time block for every KinCare.';
    }
    const seenBlocks = new Set<string>();
    for (const s of slots) {
      // The duplicate rule, in block words. In block mode every KinCare in a
      // window starts at the same instant, so "same duration at the same time"
      // would refuse the perfectly good "a 30 minute AND a 60 minute, both in
      // Midday" — and would say so next to a picker that has no times in it.
      // What is actually one KinCare asked for twice is the same duration in
      // the same window, and that is what both this and `requestBooking`'s
      // server-side guard refuse.
      const key = `${s.serviceId}@block:${s.timeBlockId}`;
      if (seenBlocks.has(key)) {
        return 'Two KinCares are the same duration in the same time block. Remove one, or move it to another block.';
      }
      seenBlocks.add(key);
    }
    return null;
  }
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
  timing: BookingTiming = SPECIFIC_TIME_ONLY,
): string | null {
  if (weeklyDays.size === 0) return 'Pick at least one day of the week.';
  if (weeks < 1) return 'Choose how many weeks.';
  return slotsBlocker(slots, timing);
}

/**
 * Builds one visit for `slot` on the calendar day `d`, or null when the slot's
 * service is gone from the catalog or it has no usable start yet.
 *
 * `priceCents` still comes from the SERVICE, in both modes. A block says WHEN a
 * visit happens; the KinCare says how long it runs and what it costs, and the
 * server re-resolves the price from the same catalog either way. Nothing about
 * time-block booking touches the money.
 */
function slotVisitOn(
  d: Date,
  slot: KinCareSlot,
  services: readonly WizardService[],
  timing: BookingTiming,
): RequestBookingArgsVisit | null {
  const service = services.find((s) => s.id === slot.serviceId);
  if (!service) return null;
  const hhmm = slotStartHHmm(slot, timing);
  if (hhmm === null) return null;
  const t = parseHourMinute(hhmm);
  if (t === null) return null;
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.hour, t.minute);
  return {
    startTimeMs: dt.getTime(),
    endTimeMs: null,
    serviceId: service.id,
    serviceName: service.name,
    priceCents: service.priceCents ?? service.priceMinCents,
    timeBlockId: timing.mode === 'TIME_BLOCK' ? slot.timeBlockId : null,
  };
}

export interface BuildWeeklyVisitsParams {
  nowMs: number;
  weeklyDays: ReadonlySet<number>;
  weeks: number;
  slots: readonly KinCareSlot[];
  services: readonly WizardService[];
  /** Defaults to clock times, which is what every caller did before time blocks existed. */
  timing?: BookingTiming;
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
  const timing = params.timing ?? SPECIFIC_TIME_ONLY;
  if (weeklyDays.size === 0 || weeks < 1 || slots.length === 0) return [];

  const ordered = [...slots].sort((a, b) => compareSlots(a, b, timing));
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
        const visit = slotVisitOn(d, slot, services, timing);
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
  timing: BookingTiming = SPECIFIC_TIME_ONLY,
): RequestBookingArgsVisit[] {
  const out: RequestBookingArgsVisit[] = [];
  for (const d of dates) {
    for (const slot of slots) {
      const visit = slotVisitOn(d, slot, services, timing);
      if (visit !== null) out.push(visit);
    }
  }
  return out.sort((a, b) => a.startTimeMs - b.startTimeMs || a.serviceId.localeCompare(b.serviceId));
}

/**
 * Visits in the plan whose start has ALREADY PASSED, formatted for a warning.
 *
 * `requestBooking` refuses any visit starting more than a minute ago, and the
 * Individual pattern has never filtered for it (only the weekly expansion does)
 * — so a household that taps today and leaves the time at 09:00 in the
 * afternoon gets the whole request refused at Create Booking with no earlier
 * warning. Time blocks make that a certainty rather than a mistake: a block
 * offers ONE start time, so once today's Midday window has opened, every
 * Midday visit placed on today is in the past by construction, and the
 * household has no control to nudge.
 *
 * So the plan says so while it can still be fixed, in both modes.
 */
export function pastPlannedVisits(
  visits: readonly RequestBookingArgsVisit[],
  nowMs: number,
): RequestBookingArgsVisit[] {
  return visits.filter((v) => v.startTimeMs <= nowMs);
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
  /**
   * 'Midday (11:00 – 15:00)' when the visit was booked into a named window,
   * null when it was booked on the clock. When set it REPLACES the time in
   * {@link plannedVisitLine}: the household chose a window, and printing
   * "11:00 AM" back at them would be reporting a precision they never gave.
   */
  timeBlockLabel: string | null;
  serviceName: string;
  /** Stable list key: two KinCares of the same duration on one day differ by time or by block. */
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
export function renderPlannedVisits(
  visits: readonly RequestBookingArgsVisit[],
  blocks: readonly TimeBlockDto[] = [],
): RenderedPlannedVisit[] {
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  return [...visits]
    .sort((a, b) => a.startTimeMs - b.startTimeMs)
    .map((v) => {
      const d = new Date(v.startTimeMs);
      const block = findTimeBlock(blocks, v.timeBlockId);
      return {
        weekday: weekdayFmt.format(d),
        date: dateFmt.format(d),
        time: timeFmt.format(d),
        timeBlockLabel: block === null ? null : timeBlockLabel(block),
        serviceName: v.serviceName,
        // Two KinCares of one duration in one day are told apart by the time in
        // clock mode and by the block in block mode, where every start is equal.
        key: `${v.startTimeMs}-${v.serviceId}-${v.timeBlockId ?? ''}`,
      };
    });
}

/**
 * 'Thu, Sep 4 at 9:00 AM' — the spec's own one-line spelling of a visit — or
 * 'Thu, Sep 4 · Midday (11:00 – 15:00)' when the household picked a window
 * instead of a clock. The date half is unchanged in both: the enumeration rule
 * is about WHICH DAYS, and a block does not make a day any less specific.
 */
export function plannedVisitLine(v: RenderedPlannedVisit): string {
  if (v.timeBlockLabel !== null) return `${v.weekday}, ${v.date} · ${v.timeBlockLabel}`;
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

