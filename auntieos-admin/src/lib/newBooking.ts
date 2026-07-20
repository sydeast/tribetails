/**
 * Pure helpers for the admin "New booking request" surface (AO-25). Kept out of
 * the dialog so the date math is unit-testable (TZ-pinned) without rendering.
 *
 * Everything here is LOCAL-time (AO-18): a `<input type="datetime-local">` /
 * `type="date"` value is a wall-clock string with no zone, and `new Date(...)`
 * of that string is interpreted in the runtime's local zone, which is exactly
 * what the operator meant when they picked "the 3rd at 9am". The epoch ms we
 * send is therefore the correct instant for the operator's zone, never a UTC
 * reinterpretation.
 */

export type BookingMode = 'dates' | 'weekly';

/** A single specific-date visit row in the form (before it becomes a visit). */
export interface DateRow {
  /** `<input type="datetime-local">` value, e.g. "2026-08-03T09:00". */
  dateTimeLocal: string;
}

/** Weekday indices JS Date#getDay uses: 0 = Sunday … 6 = Saturday. */
export const WEEKDAY_LABELS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Parses a `datetime-local` string to epoch ms in LOCAL time; null if unparseable/blank. */
export function localDateTimeToMs(value: string): number | null {
  if (value.trim() === '') return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Expands a weekly recurrence into concrete visit start times (epoch ms, LOCAL).
 *
 * Walks `weeks * 7` days forward from `startDateIso` (a "YYYY-MM-DD" wall-clock
 * date) and includes any day whose weekday is in `weeklyDays`, at `time`
 * ("HH:MM"). Each selected weekday yields up to `weeks` occurrences. Returns
 * ascending, de-duplicated ms. Empty when the inputs can't produce a valid date.
 */
export function expandWeekly(opts: {
  startDateIso: string;
  time: string;
  weeklyDays: number[];
  weeks: number;
}): number[] {
  const { startDateIso, time, weeklyDays, weeks } = opts;
  if (startDateIso.trim() === '' || time.trim() === '' || weeklyDays.length === 0 || weeks < 1) {
    return [];
  }
  const [y, m, d] = startDateIso.split('-').map((n) => Number.parseInt(n, 10));
  const [hh, mm] = time.split(':').map((n) => Number.parseInt(n, 10));
  if ([y, m, d, hh, mm].some((n) => !Number.isFinite(n))) return [];

  const days = new Set(weeklyDays);
  const out: number[] = [];
  const totalDays = weeks * 7;
  for (let i = 0; i < totalDays; i += 1) {
    // Local-time construction; month is 0-based. Day math rolls over correctly.
    const day = new Date(y!, m! - 1, d! + i, hh!, mm!, 0, 0);
    if (days.has(day.getDay())) out.push(day.getTime());
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Turns specific-date rows into ascending, de-duplicated visit start times.
 * Blank/invalid rows are dropped (the form validates emptiness separately).
 */
export function visitMsFromRows(rows: DateRow[]): number[] {
  const ms = rows.map((r) => localDateTimeToMs(r.dateTimeLocal)).filter((v): v is number => v !== null);
  return [...new Set(ms)].sort((a, b) => a - b);
}

/** True when every non-empty startTime is strictly in the future (with a 1-min grace). */
export function allInFuture(startTimesMs: number[], nowMs: number): boolean {
  return startTimesMs.every((ms) => ms >= nowMs - 60_000);
}
