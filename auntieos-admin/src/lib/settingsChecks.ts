/**
 * #1593: the Settings field checks, as the admin web shows them beside each
 * field. Mirror of `mytribe/functions/src/lib/businessSettingsChecks.ts`, which
 * `saveBusinessSettings` runs on every save; the Android
 * (`ui/admin/SettingsChecks.kt`) and desktop (`web/data/SettingsChecks.kt`)
 * clients carry the same rules and the same sentences. Change all four together.
 *
 * Format, not policy: a check refuses a value no reader can use. It never picks
 * a value for the operator.
 */

export const EMAIL_INVALID = 'Enter an email like name@example.com, or leave it blank.';
export const PHONE_INVALID = 'Enter a 10-digit phone number, or leave it blank.';
export const DATE_INVALID = 'Enter a real date as YYYY-MM-DD.';
export const DATE_PAST = 'That date has passed. Pick today or a later date.';
export const HOURS_RANGE_INVALID = 'Enter both an opening and a closing time.';
export const HOURS_CLOSE_BEFORE_OPEN = 'The closing time has to be after the opening time.';
export const KINCARE_NAME_REQUIRED = 'Every KinCare type needs a name.';
export const PORTAL_LIMIT_INVALID = 'Enter a limit of 0 or more, as a whole number. 0 shows everything.';
export const THEME_INVALID = 'Pick a theme from the list.';

/** The portal's themes, with the names the desktop picker shows (`AuntieThemeCatalog.kt`). */
export const PORTAL_THEMES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'default', label: 'Default' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'clear', label: 'Clear' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'duo', label: 'Duotone' },
  { id: 'calm', label: 'Calm' },
  { id: 'hearth', label: 'Hearth' },
  { id: 'jewel', label: 'Jewel' },
  { id: 'soft', label: 'Soft' },
];

const EMAIL_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;

export function isEmailShape(raw: string): boolean {
  const t = raw.trim();
  return t.length > 0 && t.length <= 254 && EMAIL_RE.test(t) && !t.includes('..');
}

export function isUsPhoneShape(raw: string): boolean {
  const t = raw.trim();
  if (t === '' || !/^[+0-9()\-. ]+$/.test(t)) return false;
  const digits = t.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

/** Blank passes: both are optional. */
export function businessEmailError(raw: string): string | null {
  return raw.trim() === '' || isEmailShape(raw) ? null : EMAIL_INVALID;
}

export function businessPhoneError(raw: string): string | null {
  return raw.trim() === '' || isUsPhoneShape(raw) ? null : PHONE_INVALID;
}

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

/** A new closure or special-hours date: real, and today or later in the business zone. */
export function upcomingDateError(iso: string, todayIso: string): string | null {
  const t = iso.trim();
  if (!isRealDate(t)) return DATE_INVALID;
  if (t < todayIso) return DATE_PAST;
  return null;
}

/** Today as `YYYY-MM-DD` in [timeZone] (falls back to the runtime zone if it is unusable). */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function hhmm(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const padded = `${m[1]!.padStart(2, '0')}:${m[2]}`;
  return HHMM_RE.test(padded) ? padded : null;
}

/** `"HH:MM-HH:MM"`, closing after opening. Blank is the caller's call. */
export function hoursRangeError(raw: string): string | null {
  const parts = raw.split('-');
  if (parts.length !== 2) return HOURS_RANGE_INVALID;
  const open = hhmm(parts[0]!);
  const close = hhmm(parts[1]!);
  if (open === null || close === null) return HOURS_RANGE_INVALID;
  if (close <= open) return HOURS_CLOSE_BEFORE_OPEN;
  return null;
}

/** One weekday from two time inputs: both blank is Closed. */
export function dayHoursError(open: string, close: string): string | null {
  if (open.trim() === '' && close.trim() === '') return null;
  return hoursRangeError(`${open}-${close}`);
}

export function priceError(name: string, raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  if (t.startsWith('-')) return `The price for "${name}" cannot be negative.`;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return `Enter the price for "${name}" in dollars, like 25 or 25.50.`;
  return null;
}

/** The price as the booking preview may show it: only when it passes, else null. */
export function displayablePrice(raw: string): string | null {
  const t = raw.trim();
  return t !== '' && priceError('x', t) === null ? t : null;
}

export function durationError(name: string, raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  const ok = /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 1440;
  return ok ? null : `Enter the length of "${name}" in whole minutes, from 1 to 1440.`;
}

/** The name column of a KinCare row: required, and unique ignoring case among [allNames]. */
export function kinCareNameError(name: string, allNames: readonly string[]): string | null {
  const t = name.trim();
  if (t === '') return KINCARE_NAME_REQUIRED;
  const lowered = t.toLowerCase();
  if (allNames.filter((n) => n.trim().toLowerCase() === lowered).length > 1) {
    return `Two KinCare types are both called "${t}".`;
  }
  return null;
}

export function venmoHandleError(raw: string): string | null {
  const t = raw.trim().replace(/^@/, '');
  if (t === '') return null;
  return /^[A-Za-z0-9_-]{5,30}$/.test(t) ? null : 'Enter the Venmo username: 5 to 30 letters, numbers, - or _.';
}

export function paypalHandleError(raw: string): string | null {
  const t = raw.trim().replace(/^@/, '');
  if (t === '') return null;
  return /^[A-Za-z0-9]{1,20}$/.test(t) ? null : 'Enter the PayPal.Me name: up to 20 letters and numbers.';
}

export function cashappHandleError(raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  return /^\$?(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{1,20}$/.test(t)
    ? null
    : 'Enter the $Cashtag: up to 20 letters, numbers or _, with at least one letter.';
}

/** A home section's limit as typed: a whole number of 0 or more. */
export function parsePortalLimit(raw: string): { value: number } | { error: string } {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return { error: PORTAL_LIMIT_INVALID };
  const n = Number(t);
  if (!Number.isSafeInteger(n)) return { error: PORTAL_LIMIT_INVALID };
  return { value: n };
}

export function themeError(themeId: string): string | null {
  return themeId === '' || PORTAL_THEMES.some((t) => t.id === themeId) ? null : THEME_INVALID;
}

/** A refusal the server sent back, as `saveBusinessSettings` lists them. */
export interface SettingsRefusal {
  field: string;
  message: string;
}

/** The server's per-field refusals off a callable error, or `[]`. */
export function settingsRefusalsOf(err: unknown): SettingsRefusal[] {
  const details = (err as { details?: unknown } | null)?.details as { refusals?: unknown } | undefined;
  const list = details?.refusals;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (r): r is SettingsRefusal =>
      typeof r === 'object' && r !== null && typeof (r as SettingsRefusal).field === 'string' && typeof (r as SettingsRefusal).message === 'string',
  );
}

/** A closure's name, as the server reads it after the `|`. */
export const CLOSURE_NAME_REQUIRED = 'Give the closure a name.';
/** The `|` separates the date from the name in the stored entry. */
export const NAME_HAS_PIPE = 'A name cannot contain |.';

/** The name of a new closure: required, and no `|`. */
export function closureNameError(raw: string): string | null {
  if (raw.trim() === '') return CLOSURE_NAME_REQUIRED;
  if (raw.includes('|')) return NAME_HAS_PIPE;
  return null;
}

/**
 * A refused save, split for one section: the sentences for the fields that
 * section draws (shown beside each field), and the sentence for the panel
 * banner, or null when every refusal has a field to sit beside. An error that
 * is not a refusal goes to the banner whole.
 */
export function splitSettingsRefusal(
  err: unknown,
  fields: readonly string[],
): { byField: Partial<Record<string, string>>; banner: string | null } {
  const refusals = settingsRefusalsOf(err);
  if (refusals.length === 0) {
    return { byField: {}, banner: err instanceof Error && err.message !== '' ? err.message : 'Save failed.' };
  }
  const byField: Partial<Record<string, string>> = {};
  let banner: string | null = null;
  for (const r of refusals) {
    if (fields.includes(r.field)) byField[r.field] ??= r.message;
    else banner ??= r.message;
  }
  return { byField, banner };
}
