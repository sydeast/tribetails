import { str } from './coerce';
import { DAYS_OF_WEEK } from './settingsFormat';
import { weekdayAbbrev, busyWindowLabel, isValidHHmm, type BusySlotLike } from './scheduleFormat';
import { closureOccurrencesInRange, type ClosureEntry } from './closureRecurrence';

/**
 * What the booking date picker knows about a single calendar day, and how it
 * says so. Pure, so every rule below has direct vitest coverage without
 * rendering a calendar.
 *
 * ── THE TIMEZONE DECISION, stated once, here ─────────────────────────────────
 *
 * Every date and time in this module is the OPERATOR'S DEVICE WALL CLOCK. An
 * `iso` argument is a LOCAL `YYYY-MM-DD` (what `localDateIso(new Date())`
 * returns), and an `HH:mm` is a local wall-clock time. Nothing here converts
 * between zones, and that is a decision, not an omission:
 *
 *  1. The wire contract is already local. `createMultiDateBookingRequest` takes
 *     `startTimeMs` epoch ms, and `lib/newBooking.ts` has built that from the
 *     operator's local wall clock since AO-18. The Android twin
 *     (`NewBookingRequestDialog.kt`) does the same through
 *     `ZoneId.systemDefault()`. Reinterpreting the picker in a different zone
 *     would silently desynchronise the two admin clients that write the same
 *     collection, which is exactly the "a visit somebody misses" failure.
 *
 *  2. `business_settings.timeZone` is now a validated, editable setting
 *     (a field of `screens/settings/BusinessProfileSection.tsx` since issue
 *     #709, originally its own panel under issue #519) with five real
 *     consumers, all of them server-side: the phone line's open/closed answer,
 *     quote expiry, visit dates in notifications, notification template time
 *     tokens. NONE of them is a booking write. Converting the picker through it
 *     would still be wrong, and for reasons 1 and 3 rather than because nothing
 *     reads the field: the two admin clients would stop agreeing about what a
 *     booking time means, and the slot rows have no offset to convert from.
 *     So the DIALOG keeps disclosing the mismatch when the business zone
 *     disagrees with the device zone — the difference #519 made is that the
 *     operator now has somewhere to go and fix it, instead of being shown a
 *     conflict with no control behind it.
 *
 *  3. `booking_time_slots.date`/`startTime`/`endTime` carry NO zone at all, and
 *     their two writers disagree about whose clock they are in (the asymmetry
 *     `lib/scheduleFormat.ts#groupBlockedSlotsByDate` documents in full: the
 *     Google importer stamps UTC, the admin block-time form stores local wall
 *     clock verbatim). There is no offset to convert FROM. This module compares
 *     them as wall clock, the same way the Schedule screen displays them, and
 *     the picker's copy calls them "blocked" rather than claiming an instant.
 *
 * `business_settings.businessHours` values are wall clock with no zone either,
 * and they are the business's own hours, so comparing them against a local
 * wall-clock time is right for an operator sitting in the business's zone and
 * approximate for one who is travelling. That is why an hours mismatch is a
 * WARNING the operator can overrule, never a block.
 */

/**
 * `weekdayAbbrev` output to the key `businessHours` is actually keyed by.
 *
 * DERIVED from `DAYS_OF_WEEK` rather than typed out, because that list is the
 * one Settings writes and reads with, and the two orders happen to line up:
 * `DAYS_OF_WEEK` is Monday-first ("matches SettingsScreen.kt's daysOfWeek list
 * exactly") and so is this abbreviation list. Hand-copying the seven names here
 * would mean a rename in Settings silently stopped matching, and every day
 * would quietly read as closed.
 */
const ABBREV_MONDAY_FIRST = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const DAY_NAME_BY_ABBREV: Record<string, string> = Object.fromEntries(
  ABBREV_MONDAY_FIRST.map((abbrev, i) => [abbrev, DAYS_OF_WEEK[i] ?? '']),
);

/**
 * The `businessHours` map key for a local `YYYY-MM-DD`, e.g. "Monday".
 *
 * Routes through `scheduleFormat`'s `weekdayAbbrev` rather than parsing the
 * date again here, so the local-midnight construction that turns a bare
 * `YYYY-MM-DD` into a weekday lives in exactly one file. `new Date('2026-08-03')`
 * parses as UTC midnight and can name the wrong weekday west of Greenwich; that
 * trap is already solved there.
 */
export function businessHoursKeyForIso(iso: string): string {
  return DAY_NAME_BY_ABBREV[weekdayAbbrev(iso)] ?? '';
}

/**
 * What `businessHours[day]` says about one day.
 *
 * `closed` is the documented meaning of a blank or absent entry, which is what
 * `BusinessHoursEditor` writes for a day toggled off and what
 * `businessHoursRows` already renders as "Closed".
 *
 * `unreadable` is the legacy/hand-edited value that same editor refuses to
 * coerce (it drops that day to a free-text field with a "Check format" pill).
 * It is deliberately NOT folded into either open or closed: a value we cannot
 * parse means we do not know whether the business is open, and saying "Closed"
 * on the strength of a failed regex is the kind of authoritative-looking lie
 * this picker exists to avoid.
 */
export type DayHours =
  | { kind: 'open'; startHHmm: string; endHHmm: string }
  | { kind: 'closed' }
  | { kind: 'unreadable'; raw: string };

/** Matches the "HH:MM-HH:MM" wire format `BusinessHoursEditor` writes. */
const HOURS_RANGE_RE = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/;

/** Zero-pads a "9:00" to "09:00" so plain string comparison orders times correctly. */
function padHHmm(value: string): string {
  const [h = '', m = ''] = value.split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

/**
 * Reads one day out of the raw `businessHours` map.
 *
 * Every read goes through `str()` because this map's VALUES are raw document
 * data: `mergeBusinessSettings` type-checks the map itself but never descends
 * into it (see `api/settings.ts`), so a legacy doc can hold a number here and
 * a bare `.trim()` would throw inside render.
 */
export function businessHoursForDay(hours: Record<string, string>, iso: string): DayHours {
  const key = businessHoursKeyForIso(iso);
  const raw = str(hours[key]).trim();
  if (raw === '') return { kind: 'closed' };
  const match = HOURS_RANGE_RE.exec(raw);
  if (!match) return { kind: 'unreadable', raw };
  const startHHmm = padHHmm(match[1]!);
  const endHHmm = padHHmm(match[2]!);
  if (!isValidHHmm(startHHmm) || !isValidHHmm(endHHmm)) return { kind: 'unreadable', raw };
  return { kind: 'open', startHHmm, endHHmm };
}

/** "9:00 AM to 5:00 PM" for an open day, the raw text for an unreadable one, "Closed" otherwise. */
export function dayHoursLabel(hours: DayHours): string {
  switch (hours.kind) {
    case 'open':
      return busyWindowLabel(hours.startHHmm, hours.endHHmm);
    case 'unreadable':
      return hours.raw;
    case 'closed':
      return 'Closed';
  }
}

/**
 * Whether a wall-clock `HH:mm` start falls inside the day's open window.
 *
 * Half-open on purpose: a visit starting exactly at closing time is outside
 * hours, one starting exactly at opening time is not. An `unreadable` day
 * answers `true`, because an unparsed range is not evidence of being shut and
 * the operator should not be nagged about a value they cannot see here.
 */
export function isWithinBusinessHours(timeHHmm: string, hours: DayHours): boolean {
  if (hours.kind === 'closed') return false;
  if (hours.kind === 'unreadable') return true;
  if (!isValidHHmm(timeHHmm)) return true;
  return timeHHmm >= hours.startHHmm && timeHHmm < hours.endHHmm;
}

/** A BLOCKED window on one day, already shaped for display. */
export interface BlockedWindow {
  /** "8:00 AM to 12:00 PM", or "Time TBD" when neither end parses. */
  label: string;
  startHHmm: string;
  endHHmm: string;
}

/** Shapes the raw `booking_time_slots` rows for one day into display windows. */
export function blockedWindows(slots: readonly BusySlotLike[]): BlockedWindow[] {
  return slots.map((slot) => ({
    label: busyWindowLabel(slot.startTime, slot.endTime),
    startHHmm: str(slot.startTime).trim(),
    endHHmm: str(slot.endTime).trim(),
  }));
}

/**
 * The blocked windows a visit starting at `timeHHmm` lands inside.
 *
 * A window missing either end is never treated as a clash: `groupBlockedSlotsByDate`
 * keeps a slot with no times at all (the day itself is the signal), and
 * inventing a boundary for it would produce a warning nobody can act on. Such a
 * slot still marks the DAY as having blocked time, it just cannot contradict a
 * specific start.
 */
export function clashingBlocks(timeHHmm: string, windows: readonly BlockedWindow[]): BlockedWindow[] {
  if (!isValidHHmm(timeHHmm)) return [];
  return windows.filter(
    (w) => isValidHHmm(w.startHHmm) && isValidHHmm(w.endHHmm) && timeHHmm >= w.startHHmm && timeHHmm < w.endHHmm,
  );
}

/**
 * C1: the closure name covering local day `iso`, or `null` when none of
 * `entries` (decoded `companyHolidays` rows) lands on it. Checks every entry
 * against the single date rather than pre-expanding a range, so a caller can
 * call this once per rendered cell without keeping a separate lookup table in
 * sync; the picker only ever renders 42 cells at a time, so the repeated work
 * is trivial.
 */
export function holidayNameForDay(entries: readonly ClosureEntry[], iso: string): string | null {
  for (const entry of entries) {
    if (closureOccurrencesInRange(entry, iso, iso).length > 0) {
      return entry.name.trim() || 'a company holiday';
    }
  }
  return null;
}

/**
 * C1: one existing calendar day that ALREADY has visits scheduled on it AND
 * is (or is about to be) a closure. The Time Off editor's answer to "what
 * happens to bookings that already exist on a day later marked closed" --
 * NOTHING happens to them automatically (see the C1 PR body for why), so this
 * is the surface-them half of that decision: the editor shows this list
 * before Save so the operator can act on it deliberately, rather than the
 * closure silently coexisting with visits nobody looked at again.
 */
export interface ClosureImpactHit {
  /** `YYYY-MM-DD`. */
  date: string;
  holidayName: string;
  /** How many existing sessions land on `date`. */
  sessionCount: number;
}

/**
 * Every closure occurrence inside `[fromIso, toIso]` that has at least one
 * entry in `sessionsByDay` (the shape `scheduleFormat.ts#sessionsByLocalDay`
 * already produces). Pure: takes the day-grouped sessions rather than the raw
 * list, so a caller already holding that grouping for another purpose does
 * not group twice.
 */
export function closureImpactHits(
  entries: readonly ClosureEntry[],
  sessionsByDay: ReadonlyMap<string, readonly unknown[]>,
  fromIso: string,
  toIso: string,
): ClosureImpactHit[] {
  const out: ClosureImpactHit[] = [];
  for (const entry of entries) {
    for (const date of closureOccurrencesInRange(entry, fromIso, toIso)) {
      const sessionCount = sessionsByDay.get(date)?.length ?? 0;
      if (sessionCount > 0) {
        out.push({ date, holidayName: entry.name.trim() || 'a company holiday', sessionCount });
      }
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * Everything the picker knows about one day cell.
 *
 * `hoursKnown` is separate from `hours` so an unreadable settings doc and a
 * genuinely closed Sunday never look alike. When availability could not be
 * read at all the caller builds these with `hoursKnown: false` /
 * `scheduleKnown: false`, and every consumer below then says "unknown" instead
 * of "available", which is the whole point: a picker that stays silent after a
 * failed read is claiming the day is fine.
 */
export interface DayAvailability {
  iso: string;
  /** Strictly before today's local date. Never selectable. */
  past: boolean;
  hours: DayHours;
  /** False when the business-hours read failed; `hours` is then meaningless. */
  hoursKnown: boolean;
  blocked: BlockedWindow[];
  /** Existing `kin_care_sessions` already on this local day. */
  sessionCount: number;
  /** False when the busy-slot or session read failed; `blocked`/`sessionCount` are then meaningless. */
  scheduleKnown: boolean;
  /**
   * C1: the closure's name when this local day is a `companyHolidays` entry
   * (`lib/closureRecurrence.ts`), `null` on an ordinary day.
   *
   * UNLIKE every other signal on this type, this one is NOT advisory. Every
   * other field here backs a WARNING the operator can knowingly submit past
   * ("the operator is the business" -- see `selectionWarnings` below); a
   * company holiday is the operator's own deliberate, typed-in statement that
   * the business is closed, so it is the one day this picker refuses to offer
   * at all (`AuntieDatePicker` disables the cell, matching `past`). The server
   * (`guardCompanyHolidayConflict`, `mytribe/functions`) is the actual
   * authority and refuses it unconditionally regardless of what this client
   * shows; this field only keeps the picker from looking like it disagrees.
   * `null` (never computed) is treated as "not a holiday", so a caller that
   * has not wired closures yet degrades to the pre-C1 behavior rather than
   * refusing to render.
   */
  holidayName: string | null;
}

/**
 * The short badge under a day number: at most one word, or null for an
 * unremarkable day. Ordered by how much it should stop the operator.
 */
export function dayBadge(day: DayAvailability): string | null {
  if (day.past) return null;
  if (day.holidayName !== null) return 'Closed';
  if (day.scheduleKnown && day.blocked.length > 0) return 'Blocked';
  if (day.hoursKnown && day.hours.kind === 'closed') return 'Closed';
  if (day.scheduleKnown && day.sessionCount > 0) return `${day.sessionCount}`;
  return null;
}

/**
 * The spoken tail of a day cell's accessible name, so a screen reader hears the
 * same thing the badge shows and then some. Empty for an unremarkable day.
 */
export function dayDescription(day: DayAvailability): string {
  if (day.past) return 'in the past, not available';
  const parts: string[] = [];
  if (day.holidayName !== null) parts.push(`closed for ${day.holidayName}, not available`);
  if (!day.hoursKnown || !day.scheduleKnown) parts.push('availability unknown');
  if (day.holidayName === null && day.hoursKnown && day.hours.kind === 'closed') parts.push('business closed');
  if (day.hoursKnown && day.hours.kind === 'open') parts.push(`open ${dayHoursLabel(day.hours)}`);
  if (day.scheduleKnown && day.blocked.length > 0) {
    parts.push(`blocked ${day.blocked.map((b) => b.label).join(', ')}`);
  }
  if (day.scheduleKnown && day.sessionCount > 0) {
    parts.push(`${day.sessionCount} visit${day.sessionCount === 1 ? '' : 's'} already scheduled`);
  }
  return parts.join(', ');
}

/**
 * The warnings for a whole selection, at the chosen start time.
 *
 * Every warning here EXCEPT the holiday one is advisory and never blocks a
 * submit: the operator is the business, and booking outside posted hours or
 * over a blocked window is theirs to decide. A `holidayName` warning is
 * different -- it can only appear here for a day the CALLER let into the
 * selection despite `AuntieDatePicker` refusing to offer it (e.g. a weekly
 * pattern generating a date that only later turned out to fall on a closure,
 * or a day picked before the operator saved a new closure in another tab), so
 * it says plainly that the date cannot be booked rather than phrasing it as a
 * choice; the actual refusal still happens server-side either way.
 *
 * A day whose availability is UNKNOWN produces no per-day warning here: the
 * caller already shows one banner saying the read failed, and repeating it 42
 * times would bury the days we do know something about.
 */
export function selectionWarnings(days: readonly DayAvailability[], timeHHmm: string): string[] {
  const out: string[] = [];
  for (const day of days) {
    const label = shortDayLabel(day.iso);
    if (day.holidayName !== null) {
      out.push(`${label}: closed for ${day.holidayName}. This date can't be booked.`);
    } else if (day.hoursKnown && day.hours.kind === 'closed') {
      out.push(`${label}: the business is closed that day.`);
    } else if (day.hoursKnown && !isWithinBusinessHours(timeHHmm, day.hours)) {
      out.push(`${label}: ${timeHHmm} is outside business hours (${dayHoursLabel(day.hours)}).`);
    }
    if (day.scheduleKnown) {
      const clashes = clashingBlocks(timeHHmm, day.blocked);
      if (clashes.length > 0) {
        out.push(`${label}: blocked time at ${clashes.map((c) => c.label).join(', ')}.`);
      }
    }
  }
  return out;
}

const MONTH_ABBREV = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Aug 3" for a local `YYYY-MM-DD`, for warning lines and chips. */
export function shortDayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTH_ABBREV[(m ?? 1) - 1] ?? ''} ${d ?? 1}`;
}
