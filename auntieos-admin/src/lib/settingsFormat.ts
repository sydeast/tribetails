import type { Timestamp } from 'firebase/firestore';
import { formatWhen, type FsTime } from './time';
import { str } from './coerce';
import type {
  BusinessSettings,
  PortalBanner,
  PortalChat,
  PortalHome,
} from '../api/settings';

/**
 * Pure Settings-overview formatting, kept out of the screen so the mapping
 * logic has direct vitest coverage (the invoiceFormat.ts / sessionFormat.ts /
 * mediaFormat.ts convention). Every helper here is READ-ONLY display shaping;
 * none of them mutate or validate for a save, since this port is the overview
 * only (edit/save is the deferred, not-yet-built surface).
 *
 * Scope note: only the `BusinessSettings` fields that actually have a home in
 * the wasm `SettingsScreen.kt` (per its `SettingsSection` switch) are surfaced
 * here. Several doc fields (`timeZone`, the legacy `notification*` toggles,
 * `defaultBookingMode`/`defaultCalendarView`, the GPS/tracking block, the ETA
 * and draft-retention options, `timeBlocks`) are defined on the doc but are
 * not rendered by ANY section of the live wasm screen (verified: zero hits
 * grepping their field names across `screens/settings/*.kt`), so porting a
 * display section for them would be inventing content the source screen does
 * not show. They stay out of this overview.
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

// ── Payment handles ─────────────────────────────────────────────────────────

export interface PaymentRow {
  label: string;
  value: string;
  isSet: boolean;
}

/** Venmo / PayPal / Cash App, in the order the wasm Payment Options panel shows them. */
export function paymentRows(settings: Pick<BusinessSettings, 'venmoHandle' | 'paypalHandle' | 'cashappHandle'>): PaymentRow[] {
  const rows: Array<[string, string]> = [
    ['Venmo', settings.venmoHandle],
    ['PayPal', settings.paypalHandle],
    ['Cash App', settings.cashappHandle],
  ];
  return rows.map(([label, value]) => {
    const trimmed = value.trim();
    return { label, value: trimmed === '' ? 'Not set (hidden on invoices)' : trimmed, isSet: trimmed !== '' };
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

// ── Booking behavior ────────────────────────────────────────────────────────

/** "On" / "Off", the wasm toggle's two states rendered as read-only text. */
export function boolLabel(value: boolean): 'On' | 'Off' {
  return value ? 'On' : 'Off';
}

// ── Branding ─────────────────────────────────────────────────────────────────

export interface BrandingRow {
  label: string;
  value: string;
}

/**
 * The five 17.2 branding fields, each blank-safe: a blank field means "use the
 * shipped default" (per the `BusinessSettings.logoUrl` doc comment), so the
 * overview says so explicitly rather than rendering an empty value that reads
 * as a data-loss bug.
 */
export function brandingRows(
  settings: Pick<BusinessSettings, 'logoUrl' | 'brandWordmark' | 'brandTagline' | 'homeGreeting' | 'homeAccentTail'>,
): BrandingRow[] {
  const rows: Array<[string, string, string]> = [
    ['Logo', settings.logoUrl, 'Default PawPrint glyph'],
    ['App name', settings.brandWordmark, 'Default: "AuntieOS"'],
    ['Tagline', settings.brandTagline, 'Default: "Tribe Tails Care"'],
    ['Home greeting', settings.homeGreeting, 'Default: time-aware greeting'],
    ['Home accent word', settings.homeAccentTail, 'Default: "Auntie."'],
  ];
  return rows.map(([label, value, defaultHint]) => {
    const trimmed = value.trim();
    return { label, value: trimmed === '' ? defaultHint : trimmed };
  });
}

// ── MyTribe portal ───────────────────────────────────────────────────────────

/** One-line summary of the top banner shown to kinfolk in the portal. */
export function portalBannerSummary(banner: PortalBanner): string {
  if (!banner.enabled) return 'Off';
  const message = banner.message.trim();
  return message === '' ? 'On (no message set)' : `On: "${message}"`;
}

/** One-line summary of the Message Auntie chat surface. */
export function portalChatSummary(chat: PortalChat): string {
  if (!chat.enabled) return 'Off';
  const away = chat.awayMessage.trim();
  return away === '' ? 'On' : `On, away message: "${away}"`;
}

/** "3 of 5 sections shown": how many configured Home sections are enabled. */
export function portalHomeSummary(home: PortalHome): string {
  const total = home.sections.length;
  if (total === 0) return 'Default layout (no custom sections configured)';
  const enabled = home.sections.filter((s) => s.enabled).length;
  return `${enabled} of ${total} sections shown`;
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
export function lastSavedLabel(updatedAt: string, updatedBy: string): string {
  const when = isoToFsTime(updatedAt);
  if (!when) return 'Never saved yet';
  const who = updatedBy.trim();
  return who === '' ? `Last saved ${formatWhen(when)}` : `Last saved ${formatWhen(when)} by ${who}`;
}
