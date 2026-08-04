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

/**
 * The number of visits a weekly rule INTENDS to create (days x weeks),
 * ignoring the future-only filter + the cap. Used to detect + surface cap
 * truncation so it is never silent. Mirrors `weeklyPotentialCount`.
 */
export function weeklyPotentialCount(weeklyDays: ReadonlySet<number>, weeks: number): number {
  return weeks < 1 ? 0 : weeklyDays.size * weeks;
}

/** First blocking reason for a weekly rule, or null when it is sendable. Mirrors `weeklyVisitsBlocker`. */
export function weeklyVisitsBlocker(weeklyDays: ReadonlySet<number>, weeks: number, time: string): string | null {
  if (weeklyDays.size === 0) return 'Pick at least one day of the week.';
  if (weeks < 1) return 'Choose how many weeks.';
  if (parseHourMinute(time) === null) return 'Enter a valid time as HH:MM.';
  return null;
}

export interface BuildWeeklyVisitsParams {
  nowMs: number;
  weeklyDays: ReadonlySet<number>;
  weeks: number;
  time: HourMinute;
  serviceId: string;
  serviceName: string;
  priceCents: number | null;
}

/**
 * Expands a weekly rule into concrete future visits. Walks each calendar day
 * from "now" (in the browser's local timezone, same as
 * `TimeZone.currentSystemDefault()`) for `weeks` weeks, emitting a visit at
 * `time` for every day whose weekday is in `weeklyDays` (0=Sun..6=Sat,
 * matching both `Date#getDay()` and the server's `weeklyDays` 0-6) and whose
 * datetime is strictly in the future (so the server's past-start rejection
 * never trips). Capped at MAX_RECURRING_VISITS. Mirrors `buildWeeklyVisits`.
 */
export function buildWeeklyVisits(params: BuildWeeklyVisitsParams): RequestBookingArgsVisit[] {
  const { nowMs, weeklyDays, weeks, time, serviceId, serviceName, priceCents } = params;
  if (weeklyDays.size === 0 || weeks < 1) return [];

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
      const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), time.hour, time.minute);
      const ms = dt.getTime();
      if (ms > nowMs) {
        out.push({ startTimeMs: ms, endTimeMs: null, serviceId, serviceName, priceCents });
      }
    }
    offset++;
  }
  return out;
}

/**
 * Expands the Individual-pattern tapped dates into visits at the chosen
 * daily time. Mirrors BookingWizardScreen.kt's `buildVisits`. Throws when
 * `time` doesn't parse. Callers are expected to have already gated Next/
 * Create Booking on `parseHourMinute(time) !== null` (same invariant as the
 * Kotlin `error("invalid time")`).
 */
export function buildVisits(
  dates: readonly Date[],
  time: string,
  service: Pick<ServiceDto, 'id' | 'name' | 'priceCents' | 'priceMinCents'>,
): RequestBookingArgsVisit[] {
  const t = parseHourMinute(time);
  if (t === null) throw new Error('invalid time');
  return dates.map((d) => {
    const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.hour, t.minute);
    return {
      startTimeMs: dt.getTime(),
      endTimeMs: null,
      serviceId: service.id,
      serviceName: service.name,
      priceCents: service.priceCents ?? service.priceMinCents,
    };
  });
}

/**
 * The 28 calendar days offered by the Individual-pattern month picker,
 * starting from the 1st of `today`'s month. Mirrors `SimpleMonthPicker`'s
 * `daysToShow` (always exactly 4 weeks from the 1st, not clipped to the
 * month's real length and not aligned to the 1st's weekday. Ported as-is
 * for date-set parity; the web grid weekday-aligns the *display* of these
 * same 28 dates, it does not change which dates are offered).
 */
export function monthPickerDays(today: Date): Date[] {
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  return Array.from({ length: 28 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
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

