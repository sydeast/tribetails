import { sessionDayKey, sessionDayLabel, groupSessionsByDay, localDateIso } from './sessionFormat';
import { str } from './coerce';

/**
 * Pure Schedule ("The Den · Schedule", `lib/nav.ts` slug `schedule`)
 * calendar/range + busy-block helpers, kept out of the screen for direct
 * vitest coverage (the invoiceFormat.ts / sessionFormat.ts convention).
 *
 * WHAT SCHEDULE ACTUALLY IS (confirmed against the wasm reference,
 * `composeApp/.../screens/schedule/ScheduleScreen.kt`): a calendar of the
 * SAME `kin_care_sessions` collection Sessions.tsx ("Auntie Time") already
 * reads, viewed as a Day/Week/Month grid with a per-day agenda list below,
 * plus a read-only "Busy" overlay sourced from `booking_time_slots`
 * (Google Calendar sync + manually-blocked windows). It is NOT the
 * business-hours/availability config screen (that is Settings), and it is
 * NOT a pure editor: the calendar/agenda IS a real, distinct read surface
 * from "Auntie Time" (a flat filtered list): this one answers "what's on
 * which day", not "what's the status of every visit".
 *
 * OUT OF SCOPE for this read-only port (see Schedule.tsx's doc comment and
 * the port report for the full list): drag-to-reschedule, "Block time"
 * create, the New Visit dialog, and the per-session `BookingDetailModal` are
 * all write/edit or detail-navigation surfaces, not part of a list/read port.
 *
 * REUSE, not re-derivation: day-grouping/day-labelling/status-adjacent day
 * keys for `kin_care_sessions` rows are already correctly fixed for AO-18 in
 * `sessionFormat.ts` (parses the free-text ISO instant into a LOCAL day, never
 * a raw string slice). This module imports those rather than re-deriving
 * local-day arithmetic for the same field a second time.
 */

// ── view mode + calendar-day arithmetic ─────────────────────────────────────

/**
 * Day and Month are kept from the wasm's four-way `ScheduleView`; the wasm's
 * separate "6 Wk" mode was a wider variant of Month with no distinct read
 * semantics (same per-day session counts, just more grid rows), so this port
 * merges it into a single 6-week Month grid that always shows the full month
 * with no truncation, rather than shipping two near-identical views. Flagged
 * as a deliberate scope-trim in the port report, not an oversight.
 */
export type ScheduleViewMode = 'day' | 'week' | 'month';

const MONTH_GRID_WEEKS = 6;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

interface DateParts {
  y: number;
  m: number; // 1-based
  d: number;
}

/**
 * Parses a `YYYY-MM-DD` calendar-day string into its numeric parts. Never
 * routes through `new Date(iso)` on a bare date string (that parses as UTC
 * midnight, the exact AO-18 trap): every date built from these parts uses the
 * `new Date(y, m - 1, d)` LOCAL constructor form instead.
 */
function parseCalendarDay(iso: string): DateParts {
  const [y, m, d] = iso.split('-').map(Number);
  return { y: y ?? 1970, m: m ?? 1, d: d ?? 1 };
}

function toLocalMidnight(iso: string): Date {
  const { y, m, d } = parseCalendarDay(iso);
  return new Date(y, m - 1, d);
}

function fromLocalMidnight(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Adds (or subtracts) whole calendar days. Month/year rollover (including
 * across a DST boundary) is handled by the `Date` engine itself, since we only
 * ever move calendar-date components, never a clock time.
 */
export function addCalendarDays(iso: string, deltaDays: number): string {
  const d = toLocalMidnight(iso);
  d.setDate(d.getDate() + deltaDays);
  return fromLocalMidnight(d);
}

/** 1 (Monday) .. 7 (Sunday), ISO day-of-week numbering (mirrors kotlinx `isoDayNumber`). */
function isoDayOfWeek(iso: string): number {
  const jsDay = toLocalMidnight(iso).getDay(); // 0 (Sun) .. 6 (Sat)
  return ((jsDay + 6) % 7) + 1;
}

/** The Monday on or before `iso` (the wasm's `weekStripDays` anchor). */
export function mondayOfWeek(iso: string): string {
  return addCalendarDays(iso, -(isoDayOfWeek(iso) - 1));
}

/** The 7 local calendar days (Monday first) of the week containing `iso`. */
export function weekDays(iso: string): string[] {
  const monday = mondayOfWeek(iso);
  return Array.from({ length: 7 }, (_, i) => addCalendarDays(monday, i));
}

function daysInMonth(y: number, m1based: number): number {
  return new Date(y, m1based, 0).getDate(); // day 0 of next month = last day of this one
}

/** `YYYY-MM-DD` of the 1st of `iso`'s month. */
function firstOfMonth(iso: string): string {
  const { y, m } = parseCalendarDay(iso);
  return `${y}-${pad(m)}-01`;
}

/**
 * A fixed `MONTH_GRID_WEEKS`-week grid (Monday-first) that always fully
 * covers the month containing `iso`, mirroring the wasm `MonthGrid`'s
 * Monday-anchored start. Fixed at 6 weeks (see `ScheduleViewMode`'s doc).
 */
export function monthGridDays(iso: string): string[] {
  const start = mondayOfWeek(firstOfMonth(iso));
  return Array.from({ length: MONTH_GRID_WEEKS * 7 }, (_, i) => addCalendarDays(start, i));
}

const WEEKDAY_ABBREV = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_ABBREV = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthAbbrevOf(iso: string): string {
  const { m } = parseCalendarDay(iso);
  return MONTH_ABBREV[m - 1] ?? '';
}

/** Short weekday label ("Mon", "Tue", …) for a `YYYY-MM-DD` day, for grid headers. */
export function weekdayAbbrev(iso: string): string {
  return WEEKDAY_ABBREV[toLocalMidnight(iso).getDay()] ?? '';
}

/** "Jul 17" / "Jul 14 to 20" / "Jul 28 to Aug 3" / "July 2026", per the active view. */
export function rangeLabel(iso: string, view: ScheduleViewMode): string {
  const { d, m, y } = parseCalendarDay(iso);
  switch (view) {
    case 'day':
      return `${monthAbbrevOf(iso)} ${d}`;
    case 'week': {
      const days = weekDays(iso);
      const start = days[0] ?? iso;
      const end = days[6] ?? iso;
      const startParts = parseCalendarDay(start);
      const endParts = parseCalendarDay(end);
      return startParts.m === endParts.m
        ? `${monthAbbrevOf(start)} ${startParts.d} to ${endParts.d}`
        : `${monthAbbrevOf(start)} ${startParts.d} to ${monthAbbrevOf(end)} ${endParts.d}`;
    }
    case 'month':
      return `${MONTH_FULL[m - 1] ?? ''} ${y}`;
  }
}

/** Steps `iso` forward/backward by one unit of the active view. */
export function shiftRange(iso: string, view: ScheduleViewMode, direction: 1 | -1): string {
  switch (view) {
    case 'day':
      return addCalendarDays(iso, direction);
    case 'week':
      return addCalendarDays(iso, 7 * direction);
    case 'month': {
      const { y, m, d } = parseCalendarDay(iso);
      const total = (y * 12 + (m - 1)) + direction;
      const newY = Math.floor(total / 12);
      const newM1based = (total % 12) + 1;
      const clampedDay = Math.min(d, daysInMonth(newY, newM1based));
      return `${newY}-${pad(newM1based)}-${pad(clampedDay)}`;
    }
  }
}

// ── session lookup by local day (for the calendar grid) ────────────────────

/**
 * `kin_care_sessions` rows keyed by their LOCAL day (`sessionDayKey`, the
 * AO-18 fix already in `sessionFormat.ts`), for O(1) per-cell lookup in the
 * week/month grid and the selected-day agenda. Built from
 * `groupSessionsByDay`'s already-chronologically-sorted-per-day output rather
 * than re-sorting here.
 */
export function sessionsByLocalDay<T extends { startTime?: string | undefined }>(rows: T[]): Map<string, T[]> {
  return new Map(groupSessionsByDay(rows).map((g) => [g.dayKeyValue, g.rows]));
}

/** Session count for one calendar-grid day, `0` (not absent) when nothing is scheduled. */
export function sessionCountForDay<T>(byDay: Map<string, T[]>, iso: string): number {
  return byDay.get(iso)?.length ?? 0;
}

export { sessionDayKey, sessionDayLabel, localDateIso };

// ── busy blocks (`booking_time_slots`) ──────────────────────────────────────

/**
 * Every `slotType` this module will positively recognize. Both real writers
 * (`createBlockedTimeSlot.ts`'s admin "Block time" path and
 * `syncGoogleCalendarBusyEvents.ts`'s Google Calendar importer, confirmed by
 * reading both) set `slotType: 'BLOCKED'` and never anything else today.
 * `'unknown'` exists so a future/unrecognized `slotType` gets an honest label
 * instead of being silently folded into "blocked" (the AO-12 lesson: a
 * positive match against the literal text, never "not something else, so
 * must be this").
 */
export type BusySlotKind = 'blocked' | 'unknown';

export function busySlotKind(slotType: string | undefined): BusySlotKind {
  return str(slotType).trim().toUpperCase() === 'BLOCKED' ? 'blocked' : 'unknown';
}

/**
 * Minimal shape this module needs from a `booking_time_slots` doc. Every field
 * is optional for the same reason `BusySlotEntry`'s are (see `api/schedule.ts`):
 * the caller's type is a cast over raw Firestore data, so a doc genuinely
 * missing `slotType` or `startTime` must reach these helpers as `undefined`
 * rather than being typed into existence and blowing up mid-render.
 */
export interface BusySlotLike {
  date?: string | undefined;
  startTime?: string | undefined;
  endTime?: string | undefined;
  slotType?: string | undefined;
}

/**
 * IMPORTANT ASYMMETRY vs. `kin_care_sessions`: `date`/`startTime`/`endTime`
 * here are NOT a parseable ISO instant, they are a bare `YYYY-MM-DD` plus two
 * `HH:mm` strings with NO timezone marker at all. Worse, the two writers do
 * not agree on whose clock those strings are in:
 *  - `syncGoogleCalendarBusyEvents.ts` stamps them from `Date#toISOString()`
 *    in UTC ("we format in UTC so the server write is deterministic and
 *    test-stable", per that file's own comment on `isoDate`/`isoTime`).
 *  - `createBlockedTimeSlot.ts` stores whatever `date`/`startTime`/`endTime`
 *    the admin's own "Block time" form submits verbatim, with no conversion,
 *    i.e. the admin's LOCAL wall-clock entry.
 * A doc from the first writer and a doc from the second can therefore encode
 * the "same" wall-clock afternoon under different clocks, and nothing on the
 * doc says which. This is a pre-existing backend inconsistency, not something
 * introduced here or fixable from a read-only client (there is no offset to
 * convert FROM). The wasm reference does not attempt a conversion either
 * (`blockedSlotsByDate` groups by the raw `date` field, `busyPlacement` parses
 * the raw `HH:mm` directly): this port matches that exactly, displaying the
 * fields as-is rather than fabricating a timezone they don't carry. Flagged
 * for operator/backend follow-up in the port report, not silently "fixed"
 * here with a guess.
 */
export function groupBlockedSlotsByDate<T extends BusySlotLike>(slots: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const slot of slots) {
    if (busySlotKind(slot.slotType) !== 'blocked') continue;
    const dateKey = str(slot.date);
    // A slot with no usable `date` has no day to hang off in the calendar at
    // all, so it is dropped rather than grouped under a fabricated key.
    if (dateKey.trim() === '') continue;
    const existing = map.get(dateKey);
    if (existing) existing.push(slot);
    else map.set(dateKey, [slot]);
  }
  for (const rows of map.values()) rows.sort((a, b) => str(a.startTime).localeCompare(str(b.startTime)));
  return map;
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `true` only for a strictly-valid 24h `HH:mm` string (mirrors the backend's own `TIME_RE`). */
export function isValidHHmm(hhmm: string): boolean {
  return HHMM_RE.test(hhmm);
}

/** "14:30" → "2:30 PM", or `null` when unparseable (never a fabricated time). */
export function formatHHmm12h(hhmm: string | undefined): string | null {
  const raw = str(hhmm);
  if (!isValidHHmm(raw)) return null;
  const [hStr, mStr] = raw.split(':');
  const hour = Number(hStr);
  const minute = mStr ?? '00';
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${minute} ${ampm}`;
}

/**
 * "8:00 AM to 9:00 AM", ported from the wasm's `sessionWindow` shape for
 * consistency: "Time TBD" only when BOTH ends are unparseable, one valid end
 * shows on its own rather than collapsing the whole row to "TBD".
 */
export function busyWindowLabel(startHHmm: string | undefined, endHHmm: string | undefined): string {
  const start = formatHHmm12h(startHHmm);
  const end = formatHHmm12h(endHHmm);
  if (!start && !end) return 'Time TBD';
  if (!end) return start as string;
  if (!start) return end;
  return `${start} to ${end}`;
}

// ── service-type legend ─────────────────────────────────────────────────────

/**
 * Every distinct, non-blank `serviceType` actually present across the given
 * `rows`, alphabetically. This is deliberately a raw extraction, not the
 * final legend order or the final legend membership:
 *
 *  - MEMBERSHIP: `Schedule.tsx` calls this with sessions already narrowed to
 *    the days on screen (`daysInView`), never the full bounded 300-session
 *    stream, so a type that only occurs outside the visible range never
 *    appears. A type present in view but never configured in
 *    `business_settings.serviceRates` still comes out of here (and stays in
 *    the legend) — a legend row answers "what's on screen", not "what did
 *    the operator configure".
 *  - ORDER: the caller re-orders this alphabetical list by each type's
 *    duration (`sortServiceTypesByDuration` in `lib/newBooking.ts`, over
 *    `BusinessSettings.serviceRates`/`serviceDurations`, the same two-source
 *    rule #373 gave the Android legend). Kept as a separate step rather than
 *    sorting by duration in here, because THIS function has no settings doc
 *    to sort by — it only ever sees the session rows.
 */
export function distinctServiceTypes<T extends { serviceType?: string | undefined }>(rows: T[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    // str(): `serviceType` is ABSENT on 76 of the 99 live kin_care_sessions.
    // Reading it blind crashed the whole Schedule page for the operator, while
    // the sandbox's handful of sessions all happened to have it (2026-07-20).
    const type = str(row.serviceType).trim();
    if (type !== '') set.add(type);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
