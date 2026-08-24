import type { TimeBlockDefinition } from '../api/settings';

/**
 * ISSUE #519: the vocabularies and validators behind the settings controls this
 * issue added, kept OUT of the React components so every rule has direct vitest
 * coverage and so the three admin surfaces can be checked against one written
 * statement of what a valid value is.
 *
 * Every allowed-value list here is the wire vocabulary the models already
 * carry, not a new one:
 *   - `defaultBookingMode`  matches Android's `BookingMode` enum names, which
 *     `BusinessSettings.defaultBookingModeEnum` parses with a fall back to
 *     SPECIFIC_TIME on anything unknown.
 *   - `trackingAccuracy`    matches Android's `TrackingAccuracy` enum names,
 *     which `LocationTrackingService` maps to a real `LocationRequest`
 *     priority.
 *   - `defaultCalendarView` matches Android's `CalendarViewMode` names.
 *
 * A STORED VALUE OUTSIDE ITS VOCABULARY IS SHOWN, NOT SWALLOWED. Every picker
 * built on these lists renders the loaded value even when it is not a member
 * (see `optionsIncluding`), because silently re-pointing a select at the first
 * legal option would let the operator's next unrelated save quietly rewrite a
 * value they never touched. That is the same rule `BusinessHoursEditor` follows
 * for a malformed hours string.
 */

// ── Booking mode / calendar view / tracking accuracy vocabularies ────────────

export interface OptionSpec {
  value: string;
  label: string;
}

export const BOOKING_MODES: readonly OptionSpec[] = [
  { value: 'SPECIFIC_TIME', label: 'A specific time (11:15 AM)' },
  { value: 'TIME_BLOCK', label: 'A time block (Midday)' },
];

export const CALENDAR_VIEWS: readonly OptionSpec[] = [
  { value: 'MONTH', label: 'Month' },
  { value: 'WEEK', label: 'Week' },
  { value: 'DAY', label: 'Day' },
];

export const TRACKING_ACCURACIES: readonly OptionSpec[] = [
  { value: 'HIGH', label: 'High (most precise, heaviest on battery)' },
  { value: 'MEDIUM', label: 'Medium (balanced)' },
  { value: 'LOW', label: 'Low (lightest on battery, least precise)' },
];

/**
 * `options`, plus `current` as its own row when the document holds something the
 * vocabulary does not list. Keeps a legacy or hand-edited value visible and
 * saveable-as-is rather than snapping the control to a value nobody chose.
 */
export function optionsIncluding(options: readonly OptionSpec[], current: string): OptionSpec[] {
  if (options.some((o) => o.value === current)) return [...options];
  return [...options, { value: current, label: `${current} (not a known value)` }];
}

// ── Whole numbers with a range ───────────────────────────────────────────────

export interface NumberFieldSpec {
  min: number;
  max: number;
  /** What the operator is told when the box holds something outside the range. */
  unit: string;
}

/**
 * The bounds each numeric setting is held to. Chosen to bracket a real answer
 * generously rather than to encode a policy: the point is to refuse a typo
 * (`3O` reading as nothing, a pasted `-1`, a stray extra zero on a retention
 * period) before it reaches a document three clients decode.
 */
export const NUMBER_FIELDS = {
  defaultTimeBlockDurationHours: { min: 1, max: 24, unit: 'hours' },
  travelBufferMinutes: { min: 0, max: 480, unit: 'minutes' },
  saveRoutesForDays: { min: 1, max: 3650, unit: 'days' },
} as const satisfies Record<string, NumberFieldSpec>;

/**
 * `raw` as a whole number inside `spec`, or an error naming what is wrong.
 * Blank is an error, never a silent zero: a cleared box is an unfinished edit,
 * and "0 minutes of travel buffer" is a real answer somebody might mean.
 */
export function parseWholeNumber(raw: string, spec: NumberFieldSpec): { value: number } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { error: 'Enter a number.' };
  if (!/^\d+$/.test(trimmed)) return { error: 'Whole numbers only.' };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { error: 'That number is too large.' };
  if (value < spec.min || value > spec.max) {
    return { error: `Enter ${spec.min} to ${spec.max} ${spec.unit}.` };
  }
  return { value };
}

// ── Option lists (`etaMinuteOptions`, `draftRetentionOptions`) ───────────────

/** How many entries one option list may hold. A dropdown longer than this is not a dropdown. */
export const MAX_OPTION_LIST_LENGTH = 12;

/**
 * A comma-separated option list, parsed to sorted unique positive whole numbers.
 *
 * These two lists are what the "On My Way" sheet and the draft-retention picker
 * OFFER, so an empty list is a dropdown with nothing in it and a duplicate is a
 * row the operator can pick twice with no way to tell which they picked. Both
 * are refused rather than quietly repaired.
 */
export function parseOptionList(raw: string, unit: string): { value: number[] } | { error: string } {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return { error: `List at least one option, in ${unit}.` };
  if (parts.length > MAX_OPTION_LIST_LENGTH) {
    return { error: `That is more than ${MAX_OPTION_LIST_LENGTH} options. Trim the list.` };
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return { error: `"${part}" is not a whole number.` };
    const n = Number(part);
    if (n <= 0) return { error: 'Every option has to be more than zero.' };
    if (!Number.isSafeInteger(n)) return { error: `"${part}" is too large.` };
    if (seen.has(n)) return { error: `${n} is listed twice.` };
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return { value: out };
}

/** An option list back as the operator types it: comma-separated, in order. */
export function formatOptionList(values: readonly number[]): string {
  return values.join(', ');
}

/**
 * The default to save alongside a freshly edited option list.
 *
 * A default that is not one of its own options is a dropdown showing a value it
 * cannot offer: the state you get by deleting the currently-selected entry.
 * Rather than blocking the save on it, the default follows the list to its
 * nearest surviving option (ties going to the smaller, so nobody is silently
 * given a LONGER wait or a LONGER retention than they had). Returns the input
 * unchanged when it is already a member, and when the list is empty there is
 * nothing to move it to.
 */
export function clampToOptions(value: number, options: readonly number[]): number {
  if (options.length === 0) return value;
  if (options.includes(value)) return value;
  let best = options[0]!;
  let bestDistance = Math.abs(best - value);
  for (const option of options) {
    const distance = Math.abs(option - value);
    if (distance < bestDistance || (distance === bestDistance && option < best)) {
      best = option;
      bestDistance = distance;
    }
  }
  return best;
}

// ── Time blocks ──────────────────────────────────────────────────────────────

export const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** How many bookable blocks one business may define. */
export const MAX_TIME_BLOCKS = 12;

/**
 * One row of the time-block editor. Every field is a plain string because this
 * is what the operator is typing, not what gets stored; `validateTimeBlocks`
 * turns a valid set of rows into `TimeBlockDefinition[]`.
 */
export interface TimeBlockDraft {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
  active: boolean;
}

/**
 * A stored block decoded for editing. Every field is optional on the wire (see
 * `TimeBlockDefinition`), so each one is coerced here rather than trusted: a
 * half-written row loaded from a hand-edited document has to reach the form as
 * editable text, not as a `.trim()` on `undefined`.
 */
export function timeBlockDraft(block: TimeBlockDefinition): TimeBlockDraft {
  return {
    id: typeof block.id === 'string' ? block.id : '',
    label: typeof block.label === 'string' ? block.label : '',
    startTime: typeof block.startTime === 'string' ? block.startTime : '',
    endTime: typeof block.endTime === 'string' ? block.endTime : '',
    active: block.active === true,
  };
}

/**
 * A url-safe id from a label ("Late afternoon" -> "late-afternoon"), used only
 * when the operator adds a row. An existing row NEVER has its id recomputed:
 * `resolveTimeBlock` matches stored sessions by the block's own identity, and
 * renaming "Midday" to "Middle of the day" must not orphan the visits already
 * labelled with it.
 */
export function slugifyBlockId(label: string, taken: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'block';
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * THE AVAILABILITY MODEL, not one more setting.
 *
 * `business_settings.timeBlocks` is the set of named windows a kinfolk books
 * INTO. Operator, 2026-08-24: "kinfolk book within time blocks, not at a
 * specific set time. I need to be able to create these time blocks and those
 * are what the kinfolk should be able to select from when booking." So a row
 * here is a product decision, and every rule below exists because a kinfolk is
 * going to be shown the result.
 *
 * NOT `booking_time_slots`. That collection is block-OUT time, written by
 * `createBlockedTimeSlot` and the Google busy importer, and it says when NOT to
 * book. These say when a booking may land. The two are never merged.
 *
 * TWO ACTIVE BLOCKS MAY NOT OVERLAP, and this is the rule with a consequence
 * behind it rather than a tidiness preference. `resolveTimeBlock`
 * (`domain/TimeBlockResolver.kt:15`) resolves a stored visit back to its block
 * with `firstOrNull` over the ACTIVE rows, so under an overlap the name a visit
 * is displayed with is decided by array order, not by the block the kinfolk
 * actually chose. A kinfolk books "Morning" and the schedule calls it "Midday".
 * INACTIVE rows are exempt because the resolver skips them and nothing can be
 * booked into them: an operator parking a seasonal block that overlaps a live
 * one is not a conflict until they switch it on.
 *
 * ROWS COME BACK SORTED BY START TIME. `firstOrNull` makes the stored order
 * load-bearing, so leaving it as "whatever order they were typed in" would make
 * the resolver's answer depend on edit history. Sorted, it depends on the clock.
 *
 * `startTime < endTime` is required rather than wrapped around midnight: the
 * resolver compares against the pair as a plain same-day range, so a block
 * written "22:00-02:00" would match nothing at all. Refusing it here is the
 * difference between the operator seeing why and the block silently never
 * applying.
 */
export function validateTimeBlocks(
  drafts: readonly TimeBlockDraft[],
): { value: TimeBlockDefinition[] } | { error: string } {
  if (drafts.length > MAX_TIME_BLOCKS) {
    return { error: `That is more than ${MAX_TIME_BLOCKS} blocks. Remove some first.` };
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  const out: TimeBlockDefinition[] = [];
  for (const draft of drafts) {
    const label = draft.label.trim();
    if (label === '') return { error: 'Every block needs a name.' };
    const lowered = label.toLowerCase();
    if (labels.has(lowered)) return { error: `Two blocks are both called "${label}".` };
    labels.add(lowered);
    if (!HHMM_REGEX.test(draft.startTime)) return { error: `"${label}" needs a start time as HH:mm.` };
    if (!HHMM_REGEX.test(draft.endTime)) return { error: `"${label}" needs an end time as HH:mm.` };
    if (draft.startTime >= draft.endTime) {
      return { error: `"${label}" has to end after it starts. A block cannot run past midnight.` };
    }
    const id = draft.id.trim();
    if (id === '') return { error: `"${label}" lost its id. Remove the row and add it again.` };
    if (ids.has(id)) return { error: `Two blocks share the id "${id}".` };
    ids.add(id);
    out.push({ id, label, startTime: draft.startTime, endTime: draft.endTime, active: draft.active });
  }
  out.sort(compareBlocksByStart);
  const clash = firstActiveOverlap(out);
  if (clash) {
    return {
      error: `"${clash[0]}" and "${clash[1]}" overlap. Two blocks a kinfolk can book at the same moment cannot both be on, because a visit in the overlap would be labelled with whichever came first.`,
    };
  }
  return { value: out };
}
/** Start time first, then end, then label, so the order is a fact about the clock and not about edit history. */
export function compareBlocksByStart(a: TimeBlockDefinition, b: TimeBlockDefinition): number {
  const byStart = (a.startTime ?? '').localeCompare(b.startTime ?? '');
  if (byStart !== 0) return byStart;
  const byEnd = (a.endTime ?? '').localeCompare(b.endTime ?? '');
  if (byEnd !== 0) return byEnd;
  return (a.label ?? '').localeCompare(b.label ?? '');
}
/**
 * The first pair of ACTIVE blocks whose windows intersect, by label, or null.
 *
 * Touching ends do NOT overlap: the resolver's range is `start until end`, half
 * open, so a visit at exactly 15:00 belongs to the block starting at 15:00 and
 * not to the one ending there. `sorted` must already be start-ordered, which is
 * what lets one pass over adjacent pairs find every intersection.
 */
export function firstActiveOverlap(sorted: readonly TimeBlockDefinition[]): [string, string] | null {
  const active = sorted.filter((b) => b.active);
  for (let i = 1; i < active.length; i += 1) {
    const prev = active[i - 1]!;
    const next = active[i]!;
    if ((next.startTime ?? '') < (prev.endTime ?? '')) {
      return [prev.label ?? prev.id ?? 'a block', next.label ?? next.id ?? 'a block'];
    }
  }
  return null;
}

/** The end time a NEW block gets: `startTime` plus the operator's default block length, capped at 23:59. */
export function defaultBlockEnd(startTime: string, durationHours: number): string {
  if (!HHMM_REGEX.test(startTime)) return '23:59';
  const [h, m] = startTime.split(':').map(Number) as [number, number];
  const end = h * 60 + m + Math.max(1, Math.round(durationHours)) * 60;
  const capped = Math.min(end, 23 * 60 + 59);
  return `${String(Math.floor(capped / 60)).padStart(2, '0')}:${String(capped % 60).padStart(2, '0')}`;
}

// ── Time zones ───────────────────────────────────────────────────────────────

/**
 * A short, always-present fallback list of IANA zone ids, used only when the
 * runtime cannot enumerate them (`Intl.supportedValuesOf` is missing on older
 * engines, and it is absent under some jsdom versions). Nothing here is a
 * policy about where the business may be: the picker also accepts any zone the
 * runtime does know, and always keeps whatever the document already holds.
 */
const FALLBACK_TIME_ZONES: readonly string[] = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'UTC',
];

/**
 * Every IANA zone id this runtime knows, with `current` and the shipped default
 * guaranteed present and the whole list sorted.
 *
 * `current` is included EVEN WHEN THE RUNTIME DOES NOT KNOW IT. A zone id can
 * be retired between tzdata releases, and dropping one would silently retarget
 * five server behaviors (`resolveBusinessOpen`, quote expiry, visit-date
 * formatting, notification tokens, the new-booking mismatch note) at whatever
 * happened to sort first.
 */
export function timeZoneOptions(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function'
      ? (Intl.supportedValuesOf('timeZone') as string[])
      : [...FALLBACK_TIME_ZONES];
  const all = new Set(supported.length > 0 ? supported : FALLBACK_TIME_ZONES);
  all.add('America/New_York');
  const trimmed = current.trim();
  if (trimmed !== '') all.add(trimmed);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/**
 * Is `zone` a zone this runtime can actually format a time in?
 *
 * Asked of the picker's own value rather than of arbitrary input, because the
 * consequence of a bad one is not a rejected form: `businessHours.ts` logs
 * `timezone-unusable` and the phone IVR falls back to answering as OPEN. An
 * operator has to be able to see that before saving, not after a caller does.
 */
export function isUsableTimeZone(zone: string): boolean {
  const trimmed = zone.trim();
  if (trimmed === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** The zone the operator's own browser is in, or '' when the runtime will not say. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}
