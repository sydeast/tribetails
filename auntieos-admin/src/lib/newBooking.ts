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

/** Weekday indices JS Date#getDay uses: 0 = Sunday … 6 = Saturday. */
export const WEEKDAY_LABELS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The number of weeks a weekly recurrence may run for, per the archive's chip row. */
export const WEEKS_OPTIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/**
 * Combines a calendar DAY with the shared start TIME into epoch ms, LOCAL.
 * Null when either half is blank or unparseable.
 *
 * The specific-dates mode used to be N `<input type="datetime-local">` rows, so
 * each row carried its own time and this was a single `new Date(string)` parse.
 * The calendar picker separates the two: the operator chooses a SET of days and
 * one time that applies to all of them, which is also what the Android twin and
 * the archive both do. Building the date from numeric parts rather than from a
 * concatenated string keeps the AO-18 guarantee explicit: `new Date(y, m-1, d,
 * hh, mm)` is unambiguously the local constructor, where a string form depends
 * on the engine's parsing rules.
 */
export function localDayTimeToMs(dayIso: string, timeHHmm: string): number | null {
  if (dayIso.trim() === '' || timeHHmm.trim() === '') return null;
  const [y, m, d] = dayIso.split('-').map((n) => Number.parseInt(n, 10));
  const [hh, mm] = timeHHmm.split(':').map((n) => Number.parseInt(n, 10));
  if ([y, m, d, hh, mm].some((n) => !Number.isFinite(n))) return null;
  const ms = new Date(y!, m! - 1, d!, hh!, mm!, 0, 0).getTime();
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
 * Turns the picked SET of local days plus one shared time into ascending,
 * de-duplicated visit start times. Unparseable days are dropped (the form
 * validates emptiness separately).
 *
 * Takes an iterable rather than an array so the dialog can hand its `Set`
 * straight in: a set is the model the calendar actually has, and converting it
 * to an array only to re-de-dupe here would be theatre.
 */
export function visitMsFromDays(days: Iterable<string>, timeHHmm: string): number[] {
  const ms = [...days]
    .map((day) => localDayTimeToMs(day, timeHHmm))
    .filter((v): v is number => v !== null);
  return [...new Set(ms)].sort((a, b) => a - b);
}

/** Ascending list of the selected local days, so chips and warnings read in date order. */
export function sortedDays(days: Iterable<string>): string[] {
  return [...days].sort();
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
 * DURATION HAS TWO SOURCES, in this order. `business_settings.serviceDurations`
 * is the operator stating the length outright, keyed by the same name; the
 * parse out of the NAME ("30Minute", "2Hrs") is the fallback. It used to be the
 * only source, which is why `durationMinutes` is nullable: a name like
 * "Consultation" states no duration and must not be assigned an invented one.
 *
 * The stored value wins whenever it is present and parses. That map is sparse,
 * nothing backfills it, and a type saved before it existed keeps the length its
 * name always implied.
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
export function serviceOptionsFromRates(
  rates: Record<string, string>,
  durations: Record<string, string> = {},
): ServiceOption[] {
  return Object.entries(rates)
    .map(([key, rate]) => ({
      name: key.trim(),
      rate: typeof rate === 'string' ? rate.trim() : '',
      durationMinutes: storedDurationMinutes(durations[key]) ?? serviceDurationMinutes(key),
    }))
    .filter((option) => option.name !== '')
    .sort((a, b) => durationRank(a.durationMinutes) - durationRank(b.durationMinutes));
}
/**
 * Minutes off a stored `serviceDurations` value, or null when there is nothing
 * usable there.
 *
 * Null rather than 0 on junk, so a mistyped duration falls through to the name
 * parse instead of declaring the service instantaneous. Zero and negatives are
 * refused for the same reason: a visit with no length is not a length.
 */
export function storedDurationMinutes(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const minutes = Number(trimmed);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.round(minutes);
}

/** Chip text: "30Minute · $25", or just the name when no rate is set. */
export function serviceChipLabel(option: ServiceOption): string {
  return option.rate === '' ? option.name : `${option.name} · $${option.rate}`;
}
