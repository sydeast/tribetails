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

// ── Services (business_settings.serviceRates) ────────────────────────────────

/**
 * One pickable service, derived from a single `serviceRates` entry.
 *
 * `serviceRates` really is the operator's Services data: a flat
 * `Record<name, rate-in-dollars-as-string>` edited in Settings by
 * `KinCareRatesEditor`, e.g. `{ "30Minute": "25", "Half-Day 6Hrs": "100" }`.
 * The backend agrees it is the source of truth — `getServiceCatalog` reads this
 * map first and only falls back to the legacy `base_services` collection when it
 * is empty.
 *
 * There is NO duration field anywhere on this doc: the duration lives inside the
 * NAME ("30Minute", "2Hrs"), which is why sorting needs a parse rather than a
 * lookup, and why `durationMinutes` is nullable — a name like "Consultation"
 * genuinely states no duration and must not be assigned an invented one.
 */
export interface ServiceOption {
  /** The map KEY, trimmed. This is the canonical name sent to the callable. */
  name: string;
  /** The rate exactly as the operator typed it; '' when they left it unset. */
  rate: string;
  /** Minutes parsed out of `name`; null when the name states no duration. */
  durationMinutes: number | null;
}

/**
 * Matches a duration stated inside a service name. Ported verbatim from the
 * archive's `sortServiceTypesByDuration` (BookingScreen.kt:733, and its Android
 * mirror `ServiceTypeSort.kt`), including the alternation order: `h` precedes
 * `hr`/`hrs`, and both engines prefer the leftmost alternative, so "6Hrs" yields
 * unit "h" and is read as hours either way.
 */
const DURATION_RE = /(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)/gi;

/**
 * Minutes stated in a service name: "45Minute" to 45, "1Hr" to 60,
 * "Half-Day 6Hrs" to 360. Null when nothing parses.
 *
 * The LARGEST match wins, exactly as the archive does, so a compound name
 * ("Half-Day 6Hrs") reads as its real length rather than as whatever number
 * happened to appear first.
 */
export function serviceDurationMinutes(name: string): number | null {
  let best: number | null = null;
  // A /g regex carries lastIndex across calls; a fresh instance per call keeps
  // this pure (the same input always gives the same answer).
  const re = new RegExp(DURATION_RE.source, 'gi');
  for (const m of name.matchAll(re)) {
    const n = Number.parseInt(m[1]!, 10);
    if (!Number.isFinite(n)) continue;
    const minutes = m[2]!.toLowerCase().startsWith('h') ? n * 60 : n;
    if (best === null || minutes > best) best = minutes;
  }
  return best;
}

/**
 * Orders service names by parsed duration, shortest first. Names with no
 * parseable duration sort LAST, keeping their input order.
 *
 * Ports the archive's `sortServiceTypesByDuration`. Deterministic on every
 * input: `Array.prototype.sort` is stable (ES2019+) and equal durations
 * therefore keep the caller's order, matching Kotlin's `sortedBy`. Never
 * mutates the input.
 */
export function sortServiceTypesByDuration(types: readonly string[]): string[] {
  return [...types].sort((a, b) => durationRank(serviceDurationMinutes(a)) - durationRank(serviceDurationMinutes(b)));
}

/** Sort key for a possibly-absent duration: "no stated duration" ranks after every stated one. */
function durationRank(minutes: number | null): number {
  return minutes ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Reads the `serviceRates` map into duration-ordered `ServiceOption`s.
 *
 * Blank-key entries are dropped (they are unsaveable in `KinCareRatesEditor`
 * and unpickable here). A blank rate is KEPT: the editor allows one, the
 * overview renders it as "Not set", and a configured service must not vanish
 * from the booking dialog just because its price is still blank. A non-string
 * rate (a legacy doc that stored a number) reads as '' rather than throwing on
 * `.trim()`, the `lib/coerce.ts` rule.
 */
export function serviceOptionsFromRates(rates: Record<string, string>): ServiceOption[] {
  return Object.entries(rates)
    .map(([key, rate]) => ({
      name: key.trim(),
      rate: typeof rate === 'string' ? rate.trim() : '',
      durationMinutes: serviceDurationMinutes(key),
    }))
    .filter((option) => option.name !== '')
    .sort((a, b) => durationRank(a.durationMinutes) - durationRank(b.durationMinutes));
}

/** Chip text: "30Minute · $25", or just the name when no rate is set. */
export function serviceChipLabel(option: ServiceOption): string {
  return option.rate === '' ? option.name : `${option.name} · $${option.rate}`;
}
