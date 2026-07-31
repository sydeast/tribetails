import { z } from 'zod';

/**
 * WEB MIRROR of `mytribe/functions/src/lib/closureRecurrence.ts`, the
 * server-side canonical copy. Ported verbatim (same wire grammar, same date
 * math, same zod validation) rather than imported, because `mytribe/functions`
 * and `auntieos-admin` are separate npm projects in this monorepo with no
 * shared workspace package (verified: neither `package.json` declares
 * `workspaces`, and this repo's own convention for cross-platform logic is
 * documented duplication -- see `US_HOLIDAYS` in `./settingsFormat.ts`, "Ported
 * verbatim from SettingsScreen.kt"). Any change to the recurrence rules,
 * wire grammar, or leap-day policy has to land in BOTH copies.
 *
 * Recurrence for a `business_settings.companyHolidays` closure entry.
 *
 * OPERATOR RULING (2026-07-31): a US national holiday like Independence Day
 * recurs every year. Before this, the closures editor demanded a full
 * `YYYY-MM-DD` for EVERY entry, so observing July 4th meant re-typing a new
 * dated row every January forever, and an operator who forgot one year had a
 * business that looked open on a day it was actually closed. `once` is the
 * exact pre-existing behavior (a single dated closure, e.g. "office closed for
 * the owner's surgery on 2026-09-14"); the three `yearly-*` kinds are new.
 *
 * WHY A FLOATING-DATE KIND IS SEPARATE FROM A FIXED ONE. Memorial Day is not
 * "May 25", it is the LAST MONDAY of May, and May 25 is only sometimes that
 * Monday (2026: yes; 2027: no, it is May 31). Storing it as a fixed May 25
 * would silently stop being Memorial Day the very next year the dates
 * disagree, and nothing about the stored entry would say so. `yearly-fixed`
 * is for a date that is genuinely the same every year (Jul 4, Dec 25);
 * `yearly-nth-weekday` / `yearly-last-weekday` are for a date defined BY a
 * weekday rule, computed fresh for whichever year is being asked about.
 *
 * WHY THIS STAYS `business_settings.companyHolidays: string[]`, NOT A NEW
 * FIRESTORE SHAPE. `business_settings` is a direct client `setDoc({merge:
 * true})` write (`firestore.rules` line ~178: `allow write: if isAuntie()`),
 * read by three platforms (this admin, the Android app, and the now
 * paused/superseded `web/composeApp`). Changing the array's ELEMENT TYPE from
 * string to object would require migrating every existing operator's doc
 * before any client could safely read it, and there is no callable in front of
 * this write to gate that migration through. Instead the wire format stays a
 * string, and its grammar grows a recurrence TAG in the date half:
 *
 *   once:                `YYYY-MM-DD|Name`              (unchanged, zero new syntax)
 *   yearly-fixed:        `yearly:MM-DD|Name`             e.g. `yearly:07-04|Independence Day`
 *   yearly-nth-weekday:  `yearly-nth:MM-W-N|Name`        e.g. `yearly-nth:11-4-4|Thanksgiving`
 *   yearly-last-weekday: `yearly-last:MM-W|Name`         e.g. `yearly-last:05-1|Memorial Day`
 *
 * `W` is an ISO weekday, 1 (Monday) through 7 (Sunday) -- the same convention
 * `auntieos-admin/android/.../ui/home/DashboardInsights.kt#usPetCareHolidays`
 * already uses for its (unrelated) Holiday Runway widget, so this does not
 * invent a THIRD weekday convention into a codebase that already has one. `N`
 * is 1-4 ("4th Thursday"); "last" is its own kind rather than a magic `N=5`,
 * because a month can have four or five Mondays and "5th" would silently mean
 * different things in different years.
 *
 * None of the four tags (`yearly:`, `yearly-nth:`, `yearly-last:`) can ever
 * match `^\d{4}-\d{2}-\d{2}$`, so `parseClosureEntry` tells old and new entries
 * apart by shape alone, with no version flag and no migration pass: an
 * operator's existing dated entries decode exactly as they did before this
 * shipped (`recurrence: 'once'`), untouched in Firestore, forever, unless the
 * operator edits them.
 *
 * CONSUMERS TODAY: as of this writing, nothing reads `companyHolidays` to
 * decide whether a day is bookable -- not `lib/bookingAvailability.ts` /
 * `api/availability.ts` (those check `businessHours`, `booking_time_slots`,
 * and `kin_care_sessions` only), not `screens/Schedule.tsx`, not any MyTribe
 * callable. The closures list is operator-facing data with no functional
 * consumer yet. `TimeOffEditor.tsx` IS this module's first consumer: it needs
 * a sensible date to show for a rule that has no single stored date.
 */
export type ClosureRecurrenceKind =
  | 'once'
  | 'yearly-fixed'
  | 'yearly-nth-weekday'
  | 'yearly-last-weekday';

/**
 * A decoded `companyHolidays` entry. The OUTPUT of `parseClosureEntry`, always
 * fully populated (never `undefined`): fields that do not apply to a given
 * `recurrence` are zeroed/blanked rather than omitted, so a caller can read
 * `entry.month` without first narrowing on `entry.recurrence`. Mirrors the
 * `mergeBusinessSettings` convention in `api/settings.ts` -- a parser's output
 * makes guarantees a raw cast does not.
 */
export interface ClosureEntry {
  recurrence: ClosureRecurrenceKind;
  name: string;
  /** `YYYY-MM-DD`. `once` only; `''` for every other kind. */
  date: string;
  /** 1-12. Every kind but `once` (`0`). */
  month: number;
  /** 1-31. `yearly-fixed` only (`0` otherwise). */
  day: number;
  /** ISO weekday, 1 (Monday) - 7 (Sunday). `yearly-nth-weekday` / `yearly-last-weekday` only (`0` otherwise). */
  weekday: number;
  /** 1-4. `yearly-nth-weekday` only (`0` otherwise). */
  nth: number;
}

const ONCE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEARLY_FIXED_RE = /^yearly:(\d{2})-(\d{2})$/;
const YEARLY_NTH_RE = /^yearly-nth:(\d{2})-([1-7])-([1-4])$/;
const YEARLY_LAST_RE = /^yearly-last:(\d{2})-([1-7])$/;

/** Any leap year, used only to validate that a `yearly-fixed` day (e.g. Feb 29) is a real calendar day IN SOME year. */
const LEAP_REFERENCE_YEAR = 2028;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 31;
}

/**
 * The shape-and-range gate every decoded entry passes through before it is
 * trusted, so a hand-edited or corrupted Firestore array element (an
 * out-of-range month, a weekday of 9, a day that does not exist in its month)
 * cannot silently become a wrong closure date -- it falls back to the same
 * "unparseable" treatment `parseDatedEntry` already gives a malformed row
 * (see `parseClosureEntry` below), rather than resolving to a nonsense date or
 * throwing.
 */
const closureEntrySchema = z
  .object({
    recurrence: z.enum(['once', 'yearly-fixed', 'yearly-nth-weekday', 'yearly-last-weekday']),
    name: z.string(),
    date: z.string(),
    month: z.number().int().min(0).max(12),
    day: z.number().int().min(0).max(31),
    weekday: z.number().int().min(0).max(7),
    nth: z.number().int().min(0).max(4),
  })
  .superRefine((val, ctx) => {
    if (val.recurrence === 'once') {
      if (!ONCE_RE.test(val.date)) {
        ctx.addIssue({ code: 'custom', message: 'once requires date to be YYYY-MM-DD' });
      }
      return;
    }
    if (val.month < 1 || val.month > 12) {
      ctx.addIssue({ code: 'custom', message: 'month must be 1-12' });
      return;
    }
    if (val.recurrence === 'yearly-fixed') {
      const maxDay = daysInMonth(LEAP_REFERENCE_YEAR, val.month);
      if (val.day < 1 || val.day > maxDay) {
        ctx.addIssue({ code: 'custom', message: `day must be 1-${maxDay} for month ${val.month}` });
      }
      return;
    }
    if (val.weekday < 1 || val.weekday > 7) {
      ctx.addIssue({ code: 'custom', message: 'weekday must be 1-7' });
      return;
    }
    if (val.recurrence === 'yearly-nth-weekday' && (val.nth < 1 || val.nth > 4)) {
      ctx.addIssue({ code: 'custom', message: 'nth must be 1-4' });
    }
  });

const BLANK: Omit<ClosureEntry, 'recurrence' | 'name'> = { date: '', month: 0, day: 0, weekday: 0, nth: 0 };

/**
 * Parses one `companyHolidays` wire string. NEVER THROWS: a string this
 * cannot make sense of decodes to `{ recurrence: 'once', date: '', name:
 * <the whole raw string> }`, the exact fallback `parseDatedEntry`
 * (`./settingsFormat.ts`) already gives a malformed entry, so a corrupt or
 * legacy-oddball row still renders as SOMETHING instead of vanishing or
 * crashing the settings read.
 *
 * A string with no `|` at all is that same fallback unconditionally (matching
 * `parseDatedEntry`'s behavior byte for byte): only once a pipe splits the
 * string into a date-part and a name is the date-part tested against the four
 * recognized shapes.
 */
export function parseClosureEntry(raw: string): ClosureEntry {
  const entry = raw;
  const sep = entry.indexOf('|');
  if (sep === -1) {
    return { recurrence: 'once', name: entry, ...BLANK };
  }
  const datePart = entry.slice(0, sep);
  const name = entry.slice(sep + 1);

  if (ONCE_RE.test(datePart)) {
    return finalizeOrFallback({ recurrence: 'once', name, ...BLANK, date: datePart }, entry);
  }
  const fixed = YEARLY_FIXED_RE.exec(datePart);
  if (fixed) {
    return finalizeOrFallback(
      { recurrence: 'yearly-fixed', name, ...BLANK, month: Number(fixed[1]), day: Number(fixed[2]) },
      entry,
    );
  }
  const nth = YEARLY_NTH_RE.exec(datePart);
  if (nth) {
    return finalizeOrFallback(
      {
        recurrence: 'yearly-nth-weekday',
        name,
        ...BLANK,
        month: Number(nth[1]),
        weekday: Number(nth[2]),
        nth: Number(nth[3]),
      },
      entry,
    );
  }
  const last = YEARLY_LAST_RE.exec(datePart);
  if (last) {
    return finalizeOrFallback(
      { recurrence: 'yearly-last-weekday', name, ...BLANK, month: Number(last[1]), weekday: Number(last[2]) },
      entry,
    );
  }
  // No recognized date-part shape (e.g. a hand-edited row, or plain text before
  // the pipe). Same fallback as the no-pipe case above: whole raw string as the
  // name, blank date.
  return { recurrence: 'once', name: entry, ...BLANK };
}

function finalizeOrFallback(candidate: ClosureEntry, rawEntry: string): ClosureEntry {
  const result = closureEntrySchema.safeParse(candidate);
  if (result.success) return result.data as ClosureEntry;
  return { recurrence: 'once', name: rawEntry, ...BLANK };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The inverse of `parseClosureEntry`: builds the wire string to append to
 * `companyHolidays`. Only the fields the given `recurrence` actually uses are
 * read, so a caller may pass the other fields as `0`/omitted without risk of
 * them leaking into the encoded string.
 */
export function formatClosureEntry(input: {
  recurrence: ClosureRecurrenceKind;
  name: string;
  date?: string;
  month?: number;
  day?: number;
  weekday?: number;
  nth?: number;
}): string {
  switch (input.recurrence) {
    case 'once':
      return `${input.date ?? ''}|${input.name}`;
    case 'yearly-fixed':
      return `yearly:${pad2(input.month ?? 0)}-${pad2(input.day ?? 0)}|${input.name}`;
    case 'yearly-nth-weekday':
      return `yearly-nth:${pad2(input.month ?? 0)}-${input.weekday ?? 0}-${input.nth ?? 0}|${input.name}`;
    case 'yearly-last-weekday':
      return `yearly-last:${pad2(input.month ?? 0)}-${input.weekday ?? 0}|${input.name}`;
  }
}

// Full names, not abbreviations: the editor's own Month picker (`TimeOffEditor.tsx`)
// spells the month out (e.g. "November"), so the description sitting right below
// the just-made pick echoes the same word rather than shortening it to "Nov".
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** Index 0 = ISO weekday 1 (Monday). */
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const NTH_WORDS = ['', '1st', '2nd', '3rd', '4th'];

/** "Every year, Jul 4" / "Every year, 4th Thursday of November" / "Every year, last Monday of May", or the bare `YYYY-MM-DD` for a `once` entry. */
export function describeClosureRecurrence(entry: ClosureEntry): string {
  switch (entry.recurrence) {
    case 'once':
      return entry.date;
    case 'yearly-fixed':
      return `Every year, ${MONTH_NAMES[entry.month - 1] ?? '?'} ${entry.day}`;
    case 'yearly-nth-weekday':
      return `Every year, ${NTH_WORDS[entry.nth] ?? '?'} ${WEEKDAY_NAMES[entry.weekday - 1] ?? '?'} of ${
        MONTH_NAMES[entry.month - 1] ?? '?'
      }`;
    case 'yearly-last-weekday':
      return `Every year, last ${WEEKDAY_NAMES[entry.weekday - 1] ?? '?'} of ${MONTH_NAMES[entry.month - 1] ?? '?'}`;
  }
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/**
 * ISO weekday (1 Monday .. 7 Sunday) for a Y/M/D, computed via `Date.UTC` so
 * the answer can never drift with the host's local timezone: a weekday is a
 * property of the calendar date alone, not of where the browser happens to be
 * running.
 */
function isoWeekday(year: number, month: number, day: number): number {
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun..6=Sat
  return utcDay === 0 ? 7 : utcDay;
}

/**
 * LEAP-DAY POLICY for a `yearly-fixed` Feb 29 entry: in a non-leap year it
 * resolves to Feb 28, not Mar 1 and not "no occurrence that year".
 *
 * The alternative of skipping the year entirely would make a real company
 * closure vanish three years out of four with nothing on screen explaining
 * why the day looks open. Rolling forward to Mar 1 crosses into a different
 * month for what the operator entered as a February closure. Landing one day
 * earlier, still inside February, is the smallest possible surprise, and it
 * is the same rule generalized: `clampedDay = min(day, daysInMonth(year,
 * month))`, so Feb 29 is simply the one real-world case where the clamp ever
 * does anything (every other `yearly-fixed` day the editor accepts is valid
 * in every year by construction, per `closureEntrySchema` above).
 */
function yearlyFixedDate(year: number, month: number, day: number): string {
  const clampedDay = Math.min(day, daysInMonth(year, month));
  return isoDate(year, month, clampedDay);
}

/** The Nth weekday of `month`/`year`, or `null` if that Nth does not exist (e.g. a "5th Monday" most months do not have). */
function nthWeekdayDate(year: number, month: number, weekday: number, nth: number): string | null {
  const firstWeekday = isoWeekday(year, month, 1);
  const firstOccurrence = 1 + ((weekday - firstWeekday + 7) % 7);
  const day = firstOccurrence + (nth - 1) * 7;
  if (day > daysInMonth(year, month)) return null;
  return isoDate(year, month, day);
}

/** The LAST weekday of `month`/`year` (e.g. the last Monday of May). Always exists, unlike an Nth. */
function lastWeekdayDate(year: number, month: number, weekday: number): string {
  const lastDay = daysInMonth(year, month);
  const lastDayWeekday = isoWeekday(year, month, lastDay);
  const day = lastDay - ((lastDayWeekday - weekday + 7) % 7);
  return isoDate(year, month, day);
}

/**
 * The single date `entry` falls on in `year`. `null` for a `once` entry
 * (year-agnostic: it already has its own fixed date, see `date`) or for an
 * Nth-weekday that does not exist in that particular year/month.
 */
export function closureDateInYear(entry: ClosureEntry, year: number): string | null {
  switch (entry.recurrence) {
    case 'once':
      return null;
    case 'yearly-fixed':
      return yearlyFixedDate(year, entry.month, entry.day);
    case 'yearly-nth-weekday':
      return nthWeekdayDate(year, entry.month, entry.weekday, entry.nth);
    case 'yearly-last-weekday':
      return lastWeekdayDate(year, entry.month, entry.weekday);
  }
}

/**
 * Every date `entry` falls on within `[startIso, endIso]` (inclusive),
 * expanding a yearly recurrence across EVERY year the range touches. A range
 * crossing a year boundary (e.g. Dec 20 2026 - Jan 10 2027) needs both the
 * starting and ending year checked from a single stored entry, since a
 * December-to-January window can contain a `yearly-fixed` Jan 1 occurrence
 * from the LATER year and a Dec 25 occurrence from the EARLIER one.
 *
 * This is the resolver's one true "queried date/range" entry point: a
 * `date`-only check is just `closureOccurrencesInRange(entry, iso, iso)`.
 */
export function closureOccurrencesInRange(entry: ClosureEntry, startIso: string, endIso: string): string[] {
  if (startIso > endIso) return [];
  if (entry.recurrence === 'once') {
    if (entry.date === '') return [];
    return entry.date >= startIso && entry.date <= endIso ? [entry.date] : [];
  }
  const startYear = Number(startIso.slice(0, 4));
  const endYear = Number(endIso.slice(0, 4));
  const out: string[] = [];
  for (let year = startYear; year <= endYear; year++) {
    const occurrence = closureDateInYear(entry, year);
    if (occurrence !== null && occurrence >= startIso && occurrence <= endIso) out.push(occurrence);
  }
  return out;
}

/**
 * The next date `entry` falls on that is `>= onOrAfterIso`, or `null` (a
 * `once` entry already in the past, or an Nth-weekday so rare it does not
 * recur within the lookahead). Used for display ordering: a recurring entry
 * has no single stored date to sort dated rows by, so the editor sorts by
 * "when does this next happen" instead.
 *
 * Six years of lookahead comfortably covers every rule this module resolves
 * (worst case, a specific Nth-weekday-of-month skips at most one year running
 * short a 5th occurrence) without an unbounded loop over a malformed entry.
 */
export function nextClosureOccurrence(entry: ClosureEntry, onOrAfterIso: string): string | null {
  if (entry.recurrence === 'once') {
    return entry.date !== '' && entry.date >= onOrAfterIso ? entry.date : null;
  }
  const startYear = Number(onOrAfterIso.slice(0, 4));
  for (let year = startYear; year <= startYear + 6; year++) {
    const occurrence = closureDateInYear(entry, year);
    if (occurrence !== null && occurrence >= onOrAfterIso) return occurrence;
  }
  return null;
}

/** One US national holiday the closures editor can add in a single click. */
export interface ClosurePreset {
  id: string;
  name: string;
  recurrence: ClosureRecurrenceKind;
  month: number;
  day?: number;
  weekday?: number;
  nth?: number;
}

/**
 * The one-click US national holiday catalog for the closures editor, per the
 * 2026-07-31 operator ruling. Every entry uses the REAL recurrence rule, never
 * a fixed date standing in for a floating one -- Memorial Day is
 * `yearly-last-weekday`, not a hardcoded "May 25" that quietly stops being
 * true the next year the actual last Monday falls elsewhere.
 *
 * Ids are independent of `US_HOLIDAYS` in `./settingsFormat.ts` (the older
 * observed/not-observed checklist, a boolean per holiday with no date
 * anywhere in its storage). That list and this one serve different fields --
 * `observedUsHolidays` vs. a dated `companyHolidays` entry -- so sharing ids
 * across them is not required and this module does not import that one.
 */
export const US_HOLIDAY_PRESETS: readonly ClosurePreset[] = [
  { id: 'new_years', name: "New Year's Day", recurrence: 'yearly-fixed', month: 1, day: 1 },
  { id: 'mlk', name: 'Martin Luther King Jr. Day', recurrence: 'yearly-nth-weekday', month: 1, weekday: 1, nth: 3 },
  {
    id: 'presidents',
    name: "Presidents' Day",
    recurrence: 'yearly-nth-weekday',
    month: 2,
    weekday: 1,
    nth: 3,
  },
  { id: 'memorial', name: 'Memorial Day', recurrence: 'yearly-last-weekday', month: 5, weekday: 1 },
  { id: 'juneteenth', name: 'Juneteenth', recurrence: 'yearly-fixed', month: 6, day: 19 },
  { id: 'independence', name: 'Independence Day', recurrence: 'yearly-fixed', month: 7, day: 4 },
  { id: 'labor', name: 'Labor Day', recurrence: 'yearly-nth-weekday', month: 9, weekday: 1, nth: 1 },
  {
    id: 'indigenous_columbus',
    name: "Indigenous Peoples' Day (Columbus Day)",
    recurrence: 'yearly-nth-weekday',
    month: 10,
    weekday: 1,
    nth: 2,
  },
  { id: 'veterans', name: 'Veterans Day', recurrence: 'yearly-fixed', month: 11, day: 11 },
  { id: 'thanksgiving', name: 'Thanksgiving', recurrence: 'yearly-nth-weekday', month: 11, weekday: 4, nth: 4 },
  { id: 'christmas', name: 'Christmas Day', recurrence: 'yearly-fixed', month: 12, day: 25 },
];

/** A preset, decoded to the same `ClosureEntry` shape `parseClosureEntry` produces, ready for `formatClosureEntry` to encode onto `companyHolidays`. */
export function closureEntryFromPreset(preset: ClosurePreset): ClosureEntry {
  return {
    recurrence: preset.recurrence,
    name: preset.name,
    date: '',
    month: preset.month,
    day: preset.day ?? 0,
    weekday: preset.weekday ?? 0,
    nth: preset.nth ?? 0,
  };
}
