import type { Timestamp } from 'firebase/firestore';
import { formatWhen, type FsTime } from './time';
import { str } from './coerce';
import type { HomeSectionCfg, PortalHome } from '../api/settings';

/**
 * Pure Settings-overview formatting, kept out of the screen so the mapping
 * logic has direct vitest coverage (the invoiceFormat.ts / sessionFormat.ts /
 * mediaFormat.ts convention). Every helper here is READ-ONLY display shaping;
 * none of them mutate or validate for a save.
 *
 * TWO CLAIMS THAT USED TO STAND HERE ARE GONE, and issue #519 is about what the
 * second one cost.
 *
 * The first said "this port is the overview only (edit/save is the deferred,
 * not-yet-built surface)". It has been false for a long time:
 * `screens/settings/BusinessHoursEditor.tsx`, `TimeOffEditor.tsx`,
 * `CalendarSyncSection.tsx` and every section in `sections.tsx` save for real.
 *
 * The second listed doc fields this file would not surface — `timeZone`, the
 * legacy `notification*` toggles, `defaultBookingMode`/`defaultCalendarView`,
 * the GPS/tracking block, the ETA and draft-retention options, `timeBlocks` —
 * on the grounds that no section of the wasm screen rendered them, so showing
 * them would be inventing content. The grep behind it was accurate; the
 * conclusion was not. Treating one client's gap as a ceiling for the others is
 * how twenty operator-facing fields ended up decoded by three clients and
 * editable on none, which is what #519 found. What another surface happens to
 * render is not an argument about what a field is for.
 *
 * All of them are editable now (`TimeZoneSection.tsx`,
 * `BookingRulesSection.tsx`, `VisitsTrackingSection.tsx`), except the
 * `notification*` triple, which was deleted from the models: nothing in
 * `mytribe/functions` ever read it, and the real channel gate lives on
 * `businessSettings/notifications` (see `api/settings.ts`). This module still
 * shapes only what the Settings OVERVIEW line needs, which is a statement
 * about this file's job, not about which fields may exist.
 *
 * `mergeBusinessSettings` (api/settings.ts) type-checks every TOP-LEVEL field,
 * so the `BusinessSettings` values these helpers receive really are strings.
 * What it does not descend into is the INSIDE of a map or a list: a
 * `businessHours` value or a `companyHolidays` entry is still raw document
 * data typed by a cast. Those reads are coerced with `str` at the point of use
 * — a mistyped entry then lands on the same fallback a blank one already gets
 * ("Closed", "Not set"), instead of throwing on `.trim()` and blanking the
 * screen.
 */

// ── Business hours ───────────────────────────────────────────────────────────

/** Monday-first, matches `SettingsScreen.kt`'s `daysOfWeek` list exactly. */
export const DAYS_OF_WEEK: readonly string[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

export interface BusinessHoursRow {
  day: string;
  label: string;
}

/** One row per day of the week, in order, "Closed" for a blank/missing entry. */
export function businessHoursRows(hours: Record<string, string>): BusinessHoursRow[] {
  return DAYS_OF_WEEK.map((day) => {
    const raw = str(hours[day]).trim();
    return { day, label: raw === '' ? 'Closed' : raw };
  });
}

// ── Service rates (KinCare types) ───────────────────────────────────────────

export interface ServiceRateRow {
  type: string;
  rate: string;
}

/** One row per configured KinCare type. Blank-type keys are dropped (unsaveable in the source editor too). */
export function serviceRateRows(rates: Record<string, string>): ServiceRateRow[] {
  return Object.entries(rates)
    .filter(([type]) => type.trim() !== '')
    .map(([type, rate]) => {
      const value = str(rate);
      return { type, rate: value.trim() === '' ? 'Not set' : value };
    });
}

// ── Holidays / time off ─────────────────────────────────────────────────────

/**
 * The eleven US holidays the Time Off panel offers, id -> display name.
 * Ported verbatim from `SettingsScreen.kt`'s private `US_HOLIDAYS` list so the
 * overview's labels match the editor's exactly.
 */
export const US_HOLIDAYS: ReadonlyArray<readonly [string, string]> = [
  ['new_years', "New Year's Day"],
  ['mlk', 'Martin Luther King Jr. Day'],
  ['presidents', "Presidents' Day"],
  ['memorial', 'Memorial Day'],
  ['juneteenth', 'Juneteenth'],
  ['independence', 'Independence Day'],
  ['labor', 'Labor Day'],
  ['columbus', 'Columbus Day'],
  ['veterans', 'Veterans Day'],
  ['thanksgiving', 'Thanksgiving'],
  ['christmas', 'Christmas Day'],
];

/** Title-cases a snake_case id, e.g. `some_id` -> `Some Id`. Fallback label for an id outside the known list. */
export function humanizeId(id: string): string {
  return str(id)
    .split('_')
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Observed US holidays, in the CATALOG's fixed order (not the doc's storage
 * order, which is an unordered `Set` on the wasm side), so the overview is
 * stable across reloads. An id outside the known catalog still renders
 * (humanized), rather than silently dropping data the operator's doc has.
 */
export function observedHolidayLabels(observedIds: string[]): string[] {
  const idSet = new Set(observedIds);
  const known = US_HOLIDAYS.filter(([id]) => idSet.has(id)).map(([, name]) => name);
  const knownIds = new Set(US_HOLIDAYS.map(([id]) => id));
  const unknown = observedIds.filter((id) => !knownIds.has(id)).map(humanizeId);
  return [...known, ...unknown];
}

export interface DatedEntry {
  date: string;
  label: string;
}

/**
 * Parses one `"YYYY-MM-DD|label"` entry (the `companyHolidays` /
 * `specialHours` wire format, `limit=2` split in the source so a pipe inside
 * the label survives). A malformed entry (no pipe) still renders, with the
 * whole string as the label and a blank date, rather than being dropped.
 */
export function parseDatedEntry(raw: string): DatedEntry {
  const entry = str(raw);
  const sep = entry.indexOf('|');
  if (sep === -1) return { date: '', label: entry };
  return { date: entry.slice(0, sep), label: entry.slice(sep + 1) };
}

/** Company holidays, oldest first; entries with no parseable date sort last. */
export function companyHolidayRows(entries: string[]): DatedEntry[] {
  return sortByDate(entries.map(parseDatedEntry));
}

/** Special (modified) hours entries, oldest first. Same shape/sort as company holidays. */
export function specialHourRows(entries: string[]): DatedEntry[] {
  return sortByDate(entries.map(parseDatedEntry));
}

function sortByDate(rows: DatedEntry[]): DatedEntry[] {
  return [...rows].sort((a, b) => {
    if (a.date === '' && b.date === '') return 0;
    if (a.date === '') return 1;
    if (b.date === '') return -1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
}

// ── MyTribe portal ───────────────────────────────────────────────────────────

/** "3 of 5 sections shown": how many configured Home sections are enabled. */
export function portalHomeSummary(home: PortalHome): string {
  const total = home.sections.length;
  if (total === 0) return 'Default layout (no custom sections configured)';
  const enabled = home.sections.filter((s) => s.enabled).length;
  return `${enabled} of ${total} sections shown`;
}

/**
 * M10 (issue #397): the Home sections a kinfolk portal actually knows how to
 * render, one-for-one with `CANONICAL_HOME_ORDER` in
 * `mytribe/web/src/lib/portalFormat.ts` and the Kotlin `CANONICAL_HOME_ORDER`
 * in HomeScreen.kt — three independent copies of the same fixed id list
 * because none of the three clients share a source tree. A change to one
 * canonical order is a change to all three.
 */
export const HOME_SECTION_CATALOG: readonly { id: string; label: string }[] = [
  { id: 'liveVisit', label: 'Live visit' },
  { id: 'upNext', label: 'Up next' },
  { id: 'tales', label: 'Recent KinTales' },
  { id: 'roster', label: 'Tribe roster' },
  { id: 'quickStart', label: 'Quick start' },
];

/** The operator-facing name for a section id, or the raw id itself for one this catalogue doesn't know (a legacy or future row must still be nameable, never hidden). */
export function homeSectionLabel(id: string | undefined): string {
  if (!id) return 'Unnamed section';
  return HOME_SECTION_CATALOG.find((s) => s.id === id)?.label ?? id;
}

/**
 * The rows the Home layout editor renders, derived from the persisted
 * `sections` array without mutating it.
 *
 * `resolveHomeLayout` (the portal's own read side, ported in both
 * `mytribe/web/src/lib/portalFormat.ts` and HomeScreen.kt) treats an EMPTY
 * array as "no config at all": the canonical order, every section shown,
 * unlimited. This mirrors that first branch so the editor opens showing
 * exactly what a kinfolk would see today, not a blank list — otherwise the
 * very first thing an operator could do here is toggle something off that
 * was already showing, with no honest starting point to toggle back to.
 *
 * A NON-empty array is different: any catalogue id it omits is a section the
 * portal already never shows (an omitted row, not merely an off one). Those
 * missing rows are appended here, disabled, so they stay reachable — a
 * persisted field a past edit dropped must still be one this editor can turn
 * back on, never a row silently unreachable from every client.
 */
export function effectiveHomeSections(sections: readonly HomeSectionCfg[]): HomeSectionCfg[] {
  if (sections.length === 0) {
    return HOME_SECTION_CATALOG.map((s) => ({ id: s.id, enabled: true, limit: 0 }));
  }
  const present = new Set(sections.map((s) => s.id));
  const missing = HOME_SECTION_CATALOG.filter((s) => !present.has(s.id)).map((s) => ({
    id: s.id,
    enabled: false,
    limit: 0,
  }));
  return [...sections, ...missing];
}

/** Reorders one step earlier. No-op at the top or out of range. */
export function moveHomeSectionUp<T>(rows: readonly T[], index: number): T[] {
  if (index <= 0 || index >= rows.length) return [...rows];
  const copy = [...rows];
  const above = copy[index - 1]!;
  const at = copy[index]!;
  copy[index - 1] = at;
  copy[index] = above;
  return copy;
}

/** Reorders one step later. No-op at the bottom or out of range. */
export function moveHomeSectionDown<T>(rows: readonly T[], index: number): T[] {
  return moveHomeSectionUp(rows, index + 1);
}

// ── Meta ─────────────────────────────────────────────────────────────────────

function isoToFsTime(iso: string): FsTime {
  const trimmed = iso.trim();
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return { toDate: () => d } as unknown as Timestamp;
}

/**
 * "Last saved MM-DD HH:mm by X", LOCAL time (AO-18: no UTC slicing), or "Never
 * saved yet" for a doc with a blank `updatedAt` (a never-configured install,
 * or a doc predating the field). Wraps the ISO string as a fake Firestore
 * `Timestamp` to flow through `lib/time.ts`'s LOCAL `formatWhen`, the same
 * convention `mediaFormat.ts`/`sessionFormat.ts`/`kinTaleFormat.ts` use for
 * this collection's free-text ISO fields.
 */
/**
 * What to say where a logo is not showing. Three states, deliberately three
 * different sentences: a logo that is set, one the operator CLEARED, and one
 * that was never configured.
 *
 * The last two are both `logoUrl === ''` on the doc, which is exactly why
 * `logoRemovedAt` exists. Collapsing them into one "No logo set" would mean an
 * operator who just pressed Remove sees the same panel a fresh install shows
 * and has no confirmation the removal actually landed.
 */
export function logoStateLabel(logoUrl: string, logoRemovedAt: string): string {
  if (logoUrl.trim() !== '') return 'Logo set';
  const when = isoToFsTime(logoRemovedAt);
  if (!when) return 'No logo set yet';
  return `Logo removed ${formatWhen(when)}`;
}

export function lastSavedLabel(updatedAt: string, updatedBy: string): string {
  const when = isoToFsTime(updatedAt);
  if (!when) return 'Never saved yet';
  const who = updatedBy.trim();
  return who === '' ? `Last saved ${formatWhen(when)}` : `Last saved ${formatWhen(when)} by ${who}`;
}
