import { DAY_NAMES } from './businessHours';
import { parseClosureEntry } from './closureRecurrence';
import { calendarIdProblem } from './calendarSyncId';
import { isValidPrivacyPolicyUrl, PRIVACY_POLICY_URL_MAX_LENGTH } from './privacyPolicyUrl';
import { MAX_INSTRUCTIONS_LENGTH, PAY_METHOD_IDS } from './paymentMethods';
import { assertCloudinaryUrlInFolder } from './cloudinary';
import { BRAND_ASSET_FOLDER } from './brandAsset';
import { isEmailShape, isUsPhoneShape } from './contactShape';

export { isEmailShape, isUsPhoneShape };

/**
 * #1593: what the server accepts on `business_settings/business_settings`.
 *
 * Every Settings save on the admin web, admin Android and the desktop console
 * goes through `saveBusinessSettings` (`admin/saveBusinessSettings.ts`), and the
 * rules deny the document to every client, so this file is the one server gate
 * the operator's configuration has. It took over from `validBusinessSettings()`
 * in `firestore.rules` (#519, #1409, #1410), keeping each of its type and range
 * checks and adding the field checks the 2026-11-05 QA walk found missing.
 *
 * FORMAT, NOT POLICY. A check refuses a value no reader can use (letters in a
 * price, a negative length, a close before the open, a date that does not
 * exist, a theme the portal does not have). It never picks a value for the
 * operator: there is no ceiling on a price, no "sensible" business hours, no
 * required phone number. See the memory `operator-owns-business-settings-values`.
 *
 * The sentences are the ones the clients show beside the field. Each client
 * carries the same rule and the same sentence, so the server refusing is the
 * case where a client bug let a value through, not the normal path.
 *
 * Mirrors: `auntieos-admin/src/lib/settingsChecks.ts` (web),
 * `ui/admin/SettingsChecks.kt` (Android), `web/data/SettingsChecks.kt` (desktop).
 * Change them together.
 */

export interface SettingsRefusal {
  /** The top-level settings field the refusal is about. */
  field: string;
  /** The plain sentence the operator reads. */
  message: string;
}

export interface CheckContext {
  /** The document as stored before this save (`{}` when there is none). */
  stored: Record<string, unknown>;
  /** Today in the business's own zone, `YYYY-MM-DD`. Past-date checks read it. */
  todayIso: string;
  /** The Cloudinary account a logo URL has to belong to (`CLOUDINARY_CLOUD_NAME`). */
  cloudName: string;
}

type Check = (value: unknown, ctx: CheckContext) => string | null;

// ── Shared sentences (the clients carry these word for word) ─────────────────

export const BUSINESS_NAME_REQUIRED = 'Enter the business name.';
export const EMAIL_INVALID = 'Enter an email like name@example.com, or leave it blank.';
export const PHONE_INVALID = 'Enter a 10-digit phone number, or leave it blank.';
export const PRIVACY_URL_INVALID = 'Enter a full https:// link.';
export const TIME_ZONE_INVALID = 'Pick a time zone from the list.';
export const THEME_INVALID = 'Pick a theme from the list.';
export const DATE_INVALID = 'Enter a real date as YYYY-MM-DD.';
export const DATE_PAST = 'That date has passed. Pick today or a later date.';
export const HOURS_RANGE_INVALID = 'Enter both an opening and a closing time.';
export const HOURS_CLOSE_BEFORE_OPEN = 'The closing time has to be after the opening time.';

/** The portal's themes (`mytribe/src/.../theme/PortalThemeCatalog.kt`). */
export const PORTAL_THEME_IDS = [
  'default',
  'midnight',
  'clear',
  'sunset',
  'duo',
  'calm',
  'hearth',
  'jewel',
  'soft',
] as const;

export const BOOKING_MODES = ['SPECIFIC_TIME', 'TIME_BLOCK'] as const;
// AGENDA: Android and the desktop console offer it (web offers the first three).
export const CALENDAR_VIEWS = ['MONTH', 'WEEK', 'DAY', 'AGENDA'] as const;
export const TRACKING_ACCURACIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const MAX_TIME_BLOCKS = 12;
export const MAX_OPTION_LIST_LENGTH = 12;
export const MAX_TAG_NAME_LENGTH = 40;
export const MAX_TAGS = 200;
export const MAX_KINCARE_TYPES = 100;
export const TEXT_MAX = 500;
export const LONG_TEXT_MAX = 2000;

/**
 * Fields only the server writes. A client that sends one is refused: the sync
 * receipt is `syncGoogleCalendarBusyEvents`'s and the stamp is the save's own.
 */
export const SERVER_OWNED_SETTINGS_FIELDS: ReadonlySet<string> = new Set([
  '_id',
  'updatedAt',
  'updatedBy',
  'calendarSyncLastRunAt',
  'calendarSyncLastStatus',
  'calendarSyncLastImported',
  'calendarSyncLastError',
  // #1978: derived by the save from what is stored, see `closedDayHoursChanges`.
  'closedDayHours',
]);

/**
 * Map fields the editor always sends WHOLE: a key left out is a key the
 * operator removed. Written with `mergeFields` so a removed KinCare type does
 * not survive a key-by-key merge (`settingsWrite.ts` `WHOLE_MAP_FIELDS`, the
 * Android `BUSINESS_SETTINGS_WHOLE_MAP_FIELDS`).
 */
export const WHOLE_MAP_SETTINGS_FIELDS: ReadonlySet<string> = new Set([
  'serviceRates',
  'serviceDurations',
  'serviceStartTimeBooking',
]);

// ── Primitive shapes ─────────────────────────────────────────────────────────

export function isRealDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function isUsableTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `"9:00"` or `"09:00"` to `"09:00"`; null when it is not a time of day. */
function hhmm(raw: string): string | null {
  const t = raw.trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const padded = `${m[1]!.padStart(2, '0')}:${m[2]}`;
  return HHMM_RE.test(padded) ? padded : null;
}

/**
 * One day's hours or a special-hours entry: `"HH:MM-HH:MM"`. Returns the
 * refusal, or null when it reads. Blank is handled by the caller (it means
 * Closed on a weekday and is not allowed on a special-hours entry).
 */
export function hoursRangeProblem(raw: string): string | null {
  const parts = raw.split('-');
  if (parts.length !== 2) return HOURS_RANGE_INVALID;
  const open = hhmm(parts[0]!);
  const close = hhmm(parts[1]!);
  if (open === null || close === null) return HOURS_RANGE_INVALID;
  if (close <= open) return HOURS_CLOSE_BEFORE_OPEN;
  return null;
}

/**
 * #1978: what a save of `businessHours` does to `closedDayHours`, the hours
 * each closed day had when it was last open. A day name maps to the range to
 * keep, or to null when the kept range is to be dropped.
 *
 * A closed day is a PRESENT BLANK key in `businessHours`; that is what the
 * phone line, the booking checks and the portal read as Closed, so the hours
 * the day had cannot stay in that map. They are kept here instead, where no
 * reader of the weekly hours looks, and only the Settings editors read them,
 * to fill the Open and Close boxes when the day is switched back on.
 *
 *  - A day saved as Closed whose stored value is a readable range keeps that
 *    range. A day that is not set, already closed, or holds text nobody can
 *    read has nothing to keep, and whatever is already kept for it stays.
 *  - A day saved with hours drops what was kept for it.
 *
 * Never a default: a day with nothing kept reopens blank in every editor.
 * The clients carry the same rule for the copy they hold after a save
 * (`foldSettingsPatch.ts`, `BusinessHoursHelpers.kt`).
 */
export function closedDayHoursChanges(
  sentHours: unknown,
  stored: Record<string, unknown>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!isPlainObject(sentHours)) return out;
  const storedHours = isPlainObject(stored['businessHours']) ? stored['businessHours'] : {};
  const kept = isPlainObject(stored['closedDayHours']) ? stored['closedDayHours'] : {};
  for (const [day, value] of Object.entries(sentHours)) {
    if (!(DAY_NAMES as readonly string[]).includes(day) || typeof value !== 'string') continue;
    if (value.trim() !== '') {
      if (day in kept) out[day] = null;
      continue;
    }
    const was = storedHours[day];
    if (typeof was !== 'string') continue;
    const range = was.trim();
    if (range !== '' && hoursRangeProblem(range) === null) out[day] = range;
  }
  return out;
}

/**
 * A price on the rate card. Blank means "no price set yet" and stays legal
 * (the booking preview says so). Otherwise dollars with at most two decimals,
 * zero or more. A number is accepted for older documents that stored one.
 */
export function priceProblem(name: string, value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? null : priceSentence(name);
  }
  if (typeof value !== 'string') return priceSentence(name);
  const t = value.trim();
  if (t === '') return null;
  if (/^-/.test(t)) return `The price for "${name}" cannot be negative.`;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return priceSentence(name);
  return null;
}

function priceSentence(name: string): string {
  return `Enter the price for "${name}" in dollars, like 25 or 25.50.`;
}

/** A visit length on the rate card: blank, or whole minutes from 1 to 1440. */
export function durationProblem(name: string, value: unknown): string | null {
  const t =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : null;
  if (t === null) return durationSentence(name);
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return durationSentence(name);
  const n = Number(t);
  if (n < 1 || n > 1440) return durationSentence(name);
  return null;
}

function durationSentence(name: string): string {
  return `Enter the length of "${name}" in whole minutes, from 1 to 1440.`;
}

// ── Check builders ───────────────────────────────────────────────────────────

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function text(max: number, label: string): Check {
  return (v) => {
    if (typeof v !== 'string') return `${label} has to be text.`;
    if (v.length > max) return `Keep ${label.toLowerCase()} under ${max} characters.`;
    return null;
  };
}

function bool(label: string): Check {
  return (v) => (typeof v === 'boolean' ? null : `${label} has to be on or off.`);
}

function wholeNumber(lo: number, hi: number, unit: string): Check {
  return (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
      ? null
      : `Enter ${lo} to ${hi} ${unit}.`;
}

function oneOf(values: readonly string[], sentence: string): Check {
  return (v) => (typeof v === 'string' && values.includes(v) ? null : sentence);
}

function hourOrNull(v: unknown): string | null {
  if (v === null) return null;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23
    ? null
    : 'Pick an hour from the list.';
}

function optionList(unit: string): Check {
  return (v) => {
    if (!Array.isArray(v) || v.length === 0) return `List at least one option, in ${unit}.`;
    if (v.length > MAX_OPTION_LIST_LENGTH)
      return `That is more than ${MAX_OPTION_LIST_LENGTH} options. Trim the list.`;
    const seen = new Set<number>();
    for (const n of v) {
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0)
        return 'Every option has to be a whole number above zero.';
      if (seen.has(n)) return `${n} is listed twice.`;
      seen.add(n);
    }
    return null;
  };
}

function stringList(max: number, label: string): Check {
  return (v) => {
    if (!Array.isArray(v)) return `${label} has to be a list.`;
    if (v.length > max) return `${label} has more than ${max} entries.`;
    if (v.some((x) => typeof x !== 'string' || x.length > TEXT_MAX))
      return `${label} has an entry that is not text.`;
    return null;
  };
}

/** Entries the stored document already holds pass as they are: only new ones are checked. */
function storedEntries(ctx: CheckContext, field: string): Set<string> {
  const raw = ctx.stored[field];
  return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
}

// ── Field checks ─────────────────────────────────────────────────────────────

const checkBusinessName: Check = (v) => {
  if (typeof v !== 'string' || v.trim() === '') return BUSINESS_NAME_REQUIRED;
  if (v.length > 200) return 'Keep the business name under 200 characters.';
  return null;
};

const checkEmail: Check = (v) => {
  if (typeof v !== 'string') return EMAIL_INVALID;
  return v.trim() === '' || isEmailShape(v) ? null : EMAIL_INVALID;
};

const checkPhone: Check = (v) => {
  if (typeof v !== 'string') return PHONE_INVALID;
  return v.trim() === '' || isUsPhoneShape(v) ? null : PHONE_INVALID;
};

const checkPrivacyUrl: Check = (v) => {
  if (typeof v !== 'string') return PRIVACY_URL_INVALID;
  if (v.length > PRIVACY_POLICY_URL_MAX_LENGTH)
    return `Keep the link under ${PRIVACY_POLICY_URL_MAX_LENGTH} characters.`;
  return v === '' || isValidPrivacyPolicyUrl(v) ? null : PRIVACY_URL_INVALID;
};

const checkTimeZone: Check = (v) => {
  if (typeof v !== 'string') return TIME_ZONE_INVALID;
  return v.trim() === '' || isUsableTimeZone(v.trim()) ? null : TIME_ZONE_INVALID;
};

const checkServiceRates: Check = (v) => {
  if (!isPlainObject(v))
    return 'The KinCare types list did not arrive as a list. Reload and try again.';
  const names = Object.keys(v);
  if (names.length > MAX_KINCARE_TYPES)
    return `That is more than ${MAX_KINCARE_TYPES} KinCare types.`;
  const seen = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed === '') return 'Every KinCare type needs a name.';
    if (trimmed !== name)
      return `"${trimmed}" has spaces around its name. Remove them and save again.`;
    if (trimmed.length > 80)
      return `Keep the name "${trimmed.slice(0, 20)}..." under 80 characters.`;
    const lowered = trimmed.toLowerCase();
    if (seen.has(lowered)) return `Two KinCare types are both called "${trimmed}".`;
    seen.add(lowered);
    const problem = priceProblem(trimmed, v[name]);
    if (problem) return problem;
  }
  return null;
};

const checkServiceDurations: Check = (v) => {
  if (!isPlainObject(v))
    return 'The KinCare lengths did not arrive as a list. Reload and try again.';
  for (const [name, value] of Object.entries(v)) {
    if (name.trim() === '') return 'Every KinCare type needs a name.';
    const problem = durationProblem(name, value);
    if (problem) return problem;
  }
  return null;
};

const checkStartTimeBooking: Check = (v) => {
  if (!isPlainObject(v))
    return 'The start-time choices did not arrive as a list. Reload and try again.';
  for (const [name, value] of Object.entries(v)) {
    if (name.trim() === '' || value !== true)
      return 'The start-time choices did not arrive as a list. Reload and try again.';
  }
  return null;
};

const checkBusinessHours: Check = (v) => {
  if (!isPlainObject(v)) return 'The weekly hours did not arrive as a list. Reload and try again.';
  for (const [day, value] of Object.entries(v)) {
    if (!(DAY_NAMES as readonly string[]).includes(day))
      return `"${day}" is not a day of the week.`;
    if (typeof value !== 'string') return `${day}: ${HOURS_RANGE_INVALID}`;
    if (value.trim() === '') continue;
    const problem = hoursRangeProblem(value);
    if (problem) return `${day}: ${problem}`;
  }
  return null;
};

const checkCompanyHolidays: Check = (v, ctx) => {
  const shape = stringList(500, 'Closures')(v, ctx);
  if (shape) return shape;
  const kept = storedEntries(ctx, 'companyHolidays');
  for (const raw of v as string[]) {
    if (kept.has(raw)) continue;
    const sep = raw.indexOf('|');
    const datePart = sep === -1 ? '' : raw.slice(0, sep);
    const name = sep === -1 ? '' : raw.slice(sep + 1).trim();
    if (name === '') return 'Give the closure a name.';
    if (name.includes('|')) return 'A name cannot contain |.';
    if (/^\d{4}-/.test(datePart) || datePart === '' || sep === -1) {
      if (!isRealDate(datePart)) return DATE_INVALID;
      if (datePart < ctx.todayIso) return DATE_PAST;
      continue;
    }
    const parsed = parseClosureEntry(raw);
    if (parsed.recurrence === 'once')
      return 'That closure does not read as a date or a yearly rule. Remove it and add it again.';
  }
  return null;
};

const checkSpecialHours: Check = (v, ctx) => {
  const shape = stringList(500, 'Special hours')(v, ctx);
  if (shape) return shape;
  const kept = storedEntries(ctx, 'specialHours');
  for (const raw of v as string[]) {
    if (kept.has(raw)) continue;
    const sep = raw.indexOf('|');
    const datePart = sep === -1 ? raw : raw.slice(0, sep);
    const hours = sep === -1 ? '' : raw.slice(sep + 1);
    if (!isRealDate(datePart)) return DATE_INVALID;
    if (datePart < ctx.todayIso) return DATE_PAST;
    const problem = hoursRangeProblem(hours);
    if (problem) return problem;
  }
  return null;
};

const checkTimeBlocks: Check = (v) => {
  if (!Array.isArray(v)) return 'The time blocks did not arrive as a list. Reload and try again.';
  if (v.length > MAX_TIME_BLOCKS)
    return `That is more than ${MAX_TIME_BLOCKS} blocks. Remove some first.`;
  const ids = new Set<string>();
  const labels = new Set<string>();
  const active: Array<{ label: string; start: string; end: string }> = [];
  for (const raw of v) {
    if (!isPlainObject(raw))
      return 'The time blocks did not arrive as a list. Reload and try again.';
    const label = typeof raw['label'] === 'string' ? raw['label'].trim() : '';
    if (label === '') return 'Every block needs a name.';
    if (labels.has(label.toLowerCase())) return `Two blocks are both called "${label}".`;
    labels.add(label.toLowerCase());
    const start = typeof raw['startTime'] === 'string' ? raw['startTime'] : '';
    const end = typeof raw['endTime'] === 'string' ? raw['endTime'] : '';
    if (!HHMM_RE.test(start)) return `"${label}" needs a start time as HH:mm.`;
    if (!HHMM_RE.test(end)) return `"${label}" needs an end time as HH:mm.`;
    if (start >= end)
      return `"${label}" has to end after it starts. A block cannot run past midnight.`;
    const id = typeof raw['id'] === 'string' ? raw['id'].trim() : '';
    if (id === '') return `"${label}" lost its id. Remove the row and add it again.`;
    if (ids.has(id)) return `Two blocks share the id "${id}".`;
    ids.add(id);
    if (typeof raw['active'] !== 'boolean') return `"${label}" has to be on or off.`;
    if (raw['active']) active.push({ label, start, end });
  }
  active.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  for (let i = 1; i < active.length; i += 1) {
    if (active[i]!.start < active[i - 1]!.end) {
      return `"${active[i - 1]!.label}" and "${active[i]!.label}" overlap. Turn one off or move it.`;
    }
  }
  return null;
};

/** `venmo.com/u/<handle>`, an optional leading @. */
export function venmoHandleProblem(raw: string): string | null {
  const t = raw.trim().replace(/^@/, '');
  if (t === '') return null;
  return /^[A-Za-z0-9_-]{5,30}$/.test(t)
    ? null
    : 'Enter the Venmo username: 5 to 30 letters, numbers, - or _.';
}

/** `paypal.me/<handle>`, an optional leading @. */
export function paypalHandleProblem(raw: string): string | null {
  const t = raw.trim().replace(/^@/, '');
  if (t === '') return null;
  return /^[A-Za-z0-9]{1,20}$/.test(t)
    ? null
    : 'Enter the PayPal.Me name: up to 20 letters and numbers.';
}

/** `cash.app/<handle>`, which is the $Cashtag (the $ is optional here). */
export function cashappHandleProblem(raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  return /^\$?(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{1,20}$/.test(t)
    ? null
    : 'Enter the $Cashtag: up to 20 letters, numbers or _, with at least one letter.';
}

function handle(problem: (raw: string) => string | null): Check {
  return (v) => (typeof v === 'string' ? problem(v) : problem('\u0000'));
}

const checkPaymentOptions: Check = (v) => {
  if (!isPlainObject(v))
    return 'The payment choices did not arrive as a list. Reload and try again.';
  for (const [id, opt] of Object.entries(v)) {
    if (!(PAY_METHOD_IDS as readonly string[]).includes(id))
      return `"${id}" is not a payment method.`;
    if (!isPlainObject(opt))
      return 'The payment choices did not arrive as a list. Reload and try again.';
    if ('enabled' in opt && typeof opt['enabled'] !== 'boolean')
      return 'Each payment method has to be on or off.';
    if ('instructions' in opt) {
      const ins = opt['instructions'];
      if (typeof ins !== 'string') return 'Payment instructions have to be text.';
      if (ins.length > MAX_INSTRUCTIONS_LENGTH)
        return `Keep payment instructions under ${MAX_INSTRUCTIONS_LENGTH} characters.`;
    }
  }
  return null;
};

/**
 * #2205: what an installed old build reads when it sends a whole tag list.
 * Current clients never send one: they add and recolour one tag at a time
 * through `changeBusinessTags` and delete through `removeBusinessTag`.
 */
export const TAGS_SAVE_ONE_AT_A_TIME =
  'Tags now save one at a time. Reload the page or update the app, then try again.';

/** Key order never makes two lists differ. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** True when [sent] is the tag list as stored (a missing list reads as empty). */
export function tagListUnchanged(sent: unknown, stored: unknown): boolean {
  return canonicalJson(sent) === canonicalJson(Array.isArray(stored) ? stored : []);
}

/**
 * #2205: a whole tag list is accepted only when it is the list as stored, which
 * an editor echoing the document back may send; `saveBusinessSettings` then
 * leaves it out of the write. Any other list is refused, because the server
 * cannot tell a stale list from a deliberate one: a name missing from it may
 * have been added on another device, and a name only it has may have been
 * deleted there. Replacing the stored list with it is how tags were lost and
 * deleted tags came back.
 */
const checkTagsUnchanged =
  (field: 'householdTags' | 'petTags'): Check =>
  (v, ctx) =>
    tagListUnchanged(v, ctx.stored[field]) ? null : TAGS_SAVE_ONE_AT_A_TIME;

export const LOGO_NOT_IN_LIBRARY = 'The logo must be an image uploaded to the business library.';
/**
 * A logo URL: blank (no logo), the value already stored (an editor echoing it
 * back), or an image in the business library. The same folder check as
 * `confirmBrandAssetUpload`; the Android Branding panel stages an upload and
 * saves its URL here with the text fields.
 */
function logoProblem(value: unknown, storedValue: unknown, cloudName: string): string | null {
  if (typeof value !== 'string') return LOGO_NOT_IN_LIBRARY;
  if (value === '' || value === (storedValue ?? '')) return null;
  if (cloudName === '') return 'Image uploads are not configured on the server.';
  try {
    assertCloudinaryUrlInFolder(value, cloudName, BRAND_ASSET_FOLDER);
    return null;
  } catch {
    return LOGO_NOT_IN_LIBRARY;
  }
}
/** When the logo was last removed: blank, or an ISO timestamp. */
function removedAtProblem(value: unknown): string | null {
  if (typeof value !== 'string')
    return 'The logo removal time did not arrive as a time. Reload and try again.';
  return value === '' || !Number.isNaN(Date.parse(value))
    ? null
    : 'The logo removal time did not arrive as a time. Reload and try again.';
}
const checkLogoUrl: Check = (v, ctx) => logoProblem(v, ctx.stored['logoUrl'], ctx.cloudName);
const checkLogoRemovedAt: Check = (v) => removedAtProblem(v);
const checkCalendarSyncId: Check = (v) => {
  if (typeof v !== 'string') return calendarIdProblem('');
  return v.trim() === '' ? null : calendarIdProblem(v);
};

/**
 * `mytribePortal`, which the MyTribe section writes whole and the logo upload
 * writes a slice of. The editor echoes the two logo keys back, so they take
 * the same check as the business logo.
 */
const checkMytribePortal: Check = (v, ctx) => {
  if (!isPlainObject(v))
    return 'The portal settings did not arrive as a list. Reload and try again.';
  const storedPortal = isPlainObject(ctx.stored['mytribePortal'])
    ? ctx.stored['mytribePortal']
    : {};
  for (const key of Object.keys(v)) {
    if (!['logoUrl', 'logoRemovedAt', 'themeId', 'banner', 'home', 'chat'].includes(key)) {
      return `"${key}" is not a portal setting.`;
    }
  }
  if ('logoUrl' in v) {
    const problem = logoProblem(v['logoUrl'], storedPortal['logoUrl'], ctx.cloudName);
    if (problem) return problem;
  }
  if ('logoRemovedAt' in v) {
    const problem = removedAtProblem(v['logoRemovedAt']);
    if (problem) return problem;
  }
  if ('themeId' in v) {
    const theme = v['themeId'];
    if (
      typeof theme !== 'string' ||
      !(theme === '' || (PORTAL_THEME_IDS as readonly string[]).includes(theme))
    ) {
      return THEME_INVALID;
    }
  }
  if ('banner' in v) {
    const b = v['banner'];
    if (!isPlainObject(b))
      return 'The portal banner did not arrive as a list. Reload and try again.';
    if ('enabled' in b && typeof b['enabled'] !== 'boolean')
      return 'The banner has to be on or off.';
    for (const k of ['message', 'tone', 'dismissMode', 'id']) {
      if (k in b && typeof b[k] !== 'string')
        return 'The portal banner did not arrive as a list. Reload and try again.';
    }
    if (typeof b['message'] === 'string' && b['message'].length > TEXT_MAX) {
      return `Keep the banner message under ${TEXT_MAX} characters.`;
    }
  }
  if ('home' in v) {
    const h = v['home'];
    if (!isPlainObject(h))
      return 'The portal home layout did not arrive as a list. Reload and try again.';
    if ('sections' in h) {
      const sections = h['sections'];
      if (!Array.isArray(sections) || sections.length > 30)
        return 'The portal home layout did not arrive as a list. Reload and try again.';
      for (const s of sections) {
        if (!isPlainObject(s))
          return 'The portal home layout did not arrive as a list. Reload and try again.';
        if ('enabled' in s && typeof s['enabled'] !== 'boolean')
          return 'Each home section has to be on or off.';
        if ('limit' in s) {
          const limit = s['limit'];
          if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
            return 'Enter a limit of 0 or more, as a whole number. 0 shows everything.';
          }
        }
      }
    }
  }
  if ('chat' in v) {
    const c = v['chat'];
    if (!isPlainObject(c))
      return 'The portal chat settings did not arrive as a list. Reload and try again.';
    for (const k of ['enabled', 'hoursEnabled']) {
      if (k in c && typeof c[k] !== 'boolean') return 'Chat settings have to be on or off.';
    }
    if (
      'awayMessage' in c &&
      (typeof c['awayMessage'] !== 'string' || c['awayMessage'].length > TEXT_MAX)
    ) {
      return `Keep the away message under ${TEXT_MAX} characters.`;
    }
    for (const k of ['maxMessageLength', 'rateLimitPerHour']) {
      if (k in c && (typeof c[k] !== 'number' || !Number.isInteger(c[k]) || (c[k] as number) < 0)) {
        return 'Chat limits have to be whole numbers of 0 or more.';
      }
    }
    if ('hours' in c && !isPlainObject(c['hours']))
      return 'The chat hours did not arrive as a list. Reload and try again.';
  }
  return null;
};

/** Every field a client may save, with its check. A field not named here is refused. */
export const BUSINESS_SETTINGS_CHECKS: Readonly<Record<string, Check>> = {
  // Business profile
  businessName: checkBusinessName,
  businessEmail: checkEmail,
  businessPhone: checkPhone,
  businessAddress: text(TEXT_MAX, 'The address'),
  privacyPolicyUrl: checkPrivacyUrl,
  weatherLocation: text(TEXT_MAX, 'The weather location'),
  timeZone: checkTimeZone,
  // Branding
  brandWordmark: text(200, 'The wordmark'),
  brandTagline: text(TEXT_MAX, 'The tagline'),
  homeGreeting: text(TEXT_MAX, 'The greeting'),
  homeAccentTail: text(200, 'The accent'),
  logoUrl: checkLogoUrl,
  logoRemovedAt: checkLogoRemovedAt,
  // KinCare types
  serviceRates: checkServiceRates,
  serviceDurations: checkServiceDurations,
  serviceStartTimeBooking: checkStartTimeBooking,
  // Hours and time off
  businessHours: checkBusinessHours,
  observedUsHolidays: stringList(50, 'Observed holidays'),
  observeUsHolidays: bool('Observe US holidays'),
  companyHolidays: checkCompanyHolidays,
  specialHours: checkSpecialHours,
  // Booking rules
  defaultBookingMode: oneOf(BOOKING_MODES, 'Pick how kinfolk book from the list.'),
  defaultCalendarView: oneOf(CALENDAR_VIEWS, 'Pick a calendar view from the list.'),
  allowTimeBlockBooking: bool('Time blocks'),
  allowSpecificTimeBooking: bool('Specific times'),
  enableConflictDetection: bool('Conflict checks'),
  enableAutoReminder24h: bool('The 24-hour reminder'),
  snapRescheduleTo15Min: bool('Snap to 15 minutes'),
  autoConfirmRepeatKinfolk: bool('Auto-confirm'),
  defaultTimeBlockDurationHours: wholeNumber(1, 24, 'hours'),
  travelBufferMinutes: wholeNumber(0, 480, 'minutes'),
  timeBlocks: checkTimeBlocks,
  // Visits and tracking
  enableGPSTrackingForAllVisits: bool('GPS tracking'),
  enablePhotoLocationTagging: bool('Photo location'),
  requireArrivalDepartureVerification: bool('Verify arrival and departure'),
  // #2123: never blocks completion; it puts a "Send the KinTale" task in front
  // of the Auntie. Absent reads OFF (`lib/kinTaleRequirement.ts`).
  kinTaleRequired: bool('KinTale required'),
  autoStartTrackingOnVisitStart: bool('Auto-start tracking'),
  allowClientLocationSharing: bool('Location sharing'),
  trackingAccuracy: oneOf(TRACKING_ACCURACIES, 'Pick a tracking accuracy from the list.'),
  arrivalRadiusMeters: wholeNumber(10, 5000, 'metres'),
  saveRoutesForDays: wholeNumber(1, 3650, 'days'),
  defaultEtaMinutes: wholeNumber(1, 1440, 'minutes'),
  etaMinuteOptions: optionList('minutes'),
  draftRetentionDays: wholeNumber(1, 3650, 'days'),
  draftRetentionOptions: optionList('days'),
  // Payments
  venmoHandle: handle(venmoHandleProblem),
  paypalHandle: handle(paypalHandleProblem),
  cashappHandle: handle(cashappHandleProblem),
  paymentOptions: checkPaymentOptions,
  // Phone line and notifications
  voiceLiveTransferEnabled: bool('Live transfer'),
  householdNotificationsLive: bool('Household notifications'),
  householdNotificationHour: hourOrNull,
  scheduleDigestHour: hourOrNull,
  // Calendar sync
  calendarSyncId: checkCalendarSyncId,
  // Tags
  householdTags: checkTagsUnchanged('householdTags'),
  petTags: checkTagsUnchanged('petTags'),
  // MyTribe portal
  mytribePortal: checkMytribePortal,
};

/** #1863: the three fields the one Time Blocks | Exact times mode is written as. */
export const BOOKING_MODE_FIELDS = ['defaultBookingMode', 'allowTimeBlockBooking', 'allowSpecificTimeBooking'] as const;
export const BOOKING_MODE_SPLIT = 'Pick Time Blocks or Exact times.';
export const BOOKING_MODE_NEEDS_BLOCK = 'Time Blocks needs at least one block turned on. Turn one on, or pick Exact times.';
/**
 * #1863: the cross-field rule for the one mode. Runs only when a save names one
 * of {@link BOOKING_MODE_FIELDS} or the blocks, so a document still carrying
 * the pre-#1863 both-on shape never blocks an unrelated save.
 *
 *  - A save that names the mode must leave the document with exactly one of the
 *    two switches on and `defaultBookingMode` naming it: every editor sends
 *    all three, and anything else would be two modes at once.
 *  - Time Blocks must leave at least one active block, whether this save set
 *    the mode or turned the last block off.
 */
export function bookingModeRefusals(changes: Record<string, unknown>, stored: Record<string, unknown>): SettingsRefusal[] {
  const namesMode = BOOKING_MODE_FIELDS.some((f) => f in changes);
  if (!namesMode && !('timeBlocks' in changes)) return [];
  const raw = (f: string): unknown => (f in changes ? changes[f] : stored[f]);
  // A field the document never stored reads as its default, the same way
  // `storedBookingMode` and every client decoder read it (both switches on,
  // SPECIFIC_TIME). The Android admin saves only the fields that changed, so on
  // a document missing a field it never sends the one already at its default.
  const merged = (f: string): unknown => {
    const v = raw(f);
    if (f === 'defaultBookingMode') return v === 'TIME_BLOCK' ? 'TIME_BLOCK' : v === undefined || v === null ? 'SPECIFIC_TIME' : v;
    if (f === 'allowTimeBlockBooking' || f === 'allowSpecificTimeBooking') return typeof v === 'boolean' ? v : true;
    return v;
  };
  if (namesMode) {
    const block = merged('allowTimeBlockBooking');
    const specific = merged('allowSpecificTimeBooking');
    const named = merged('defaultBookingMode');
    const consistent =
      (block === true && specific === false && named === 'TIME_BLOCK') ||
      (block === false && specific === true && named === 'SPECIFIC_TIME');
    if (!consistent) return [{ field: 'defaultBookingMode', message: BOOKING_MODE_SPLIT }];
  }
  const blocksMode = merged('allowTimeBlockBooking') === true && merged('allowSpecificTimeBooking') === false;
  if (!blocksMode) return [];
  const rows = merged('timeBlocks');
  // Only `active: false` turns a row off, as `parseTimeBlockRow` reads it.
  const anyActive = Array.isArray(rows) && rows.some((r) => isPlainObject(r) && r['active'] !== false);
  return anyActive ? [] : [{ field: 'timeBlocks', message: BOOKING_MODE_NEEDS_BLOCK }];
}
/**
 * Every refusal for one save, in the order the fields arrived. Empty means the
 * save may be written. Unknown and server-owned fields are refused by name.
 */
export function businessSettingsRefusals(
  changes: Record<string, unknown>,
  ctx: CheckContext,
): SettingsRefusal[] {
  const out: SettingsRefusal[] = [];
  for (const [field, value] of Object.entries(changes)) {
    if (SERVER_OWNED_SETTINGS_FIELDS.has(field)) {
      out.push({ field, message: `${field} is set by the server, not by this form.` });
      continue;
    }
    const check = BUSINESS_SETTINGS_CHECKS[field];
    if (!check) {
      out.push({ field, message: `${field} is not a setting this app saves.` });
      continue;
    }
    if (value === undefined) {
      out.push({ field, message: `${field} arrived with no value.` });
      continue;
    }
    const message = check(value, ctx);
    if (message) out.push({ field, message });
  }
  return out;
}
