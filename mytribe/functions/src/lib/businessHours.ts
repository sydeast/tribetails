import type { Firestore } from 'firebase-admin/firestore';
import { parseClosureEntry, closureOccurrencesInRange, type ClosureEntry } from './closureRecurrence';

/**
 * Is the business open RIGHT NOW, as an instant, in the business's own timezone.
 *
 * THIS IS THE FIRST SERVER-SIDE READER OF `business_settings.businessHours` IN
 * THE REPO, and the first code anywhere in it that treats
 * `business_settings.timeZone` as a real conversion input.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────
 *
 * The business phone line asked this question of a Twilio Serverless function
 * that hardcoded `day >= 1 && day <= 5 && hour >= 8 && hour < 18` against
 * `America/Chicago`, computed the answer, and then discarded it: the deployed
 * body was the literal `{ is_open: false }` with a `// or true` comment beside
 * it. Every caller, at every hour, was told the business was closed. Nothing
 * observed it, because the HTTP request that returned that answer returned 200,
 * so the Studio widget that asked logged `success` and the flow's own
 * fail-open transition (`failed -> open_hours_greeting`) never fired. A wrong
 * answer delivered successfully is not a failure any retry or fallback can see.
 *
 * So the rules here are unit-tested against the real `businessHours` wire shape
 * rather than asserted, and every "we cannot tell" path FAILS OPEN and says so
 * in its `reason`, because a caller who reaches a person on a day we were
 * unsure about has lost nothing, and a caller wrongly told "we're closed" hangs
 * up and does not call back.
 *
 * ── THE TIMEZONE DECISION ─────────────────────────────────────────────────────
 *
 * `bookingAvailability.ts` and `companyHolidayConflict.ts` both decline to
 * convert through `business_settings.timeZone`, and both say why at length: the
 * value is unvalidated, nothing else honours it, and inventing a conversion the
 * rest of the app does not perform would desynchronise two admin clients that
 * write the same collection. Their reasoning is sound FOR THEM. It does not
 * transfer here, for one reason: those surfaces compare the business's hours
 * against THE OPERATOR'S OWN DEVICE CLOCK, and the operator is usually sitting
 * in the business's timezone, so the un-converted comparison is right by
 * default and only approximate when they travel.
 *
 * This module runs in `us-central1` on a machine whose clock is UTC and whose
 * locale is never the operator's. There IS no ambient wall clock here to fall
 * back on, so "do not convert" would mean comparing 08:00-18:00 Central against
 * a UTC hour, which is wrong by five or six hours every single call. Converting
 * is not the risky option here; it is the only correct one.
 *
 * The zone is therefore REQUIRED and VALIDATED (`Intl` rejects a bad IANA
 * name). A blank or unrecognised zone does not silently become UTC: it fails
 * open with `reason: 'timezone-unusable'`, which the caller logs at `error`.
 *
 * OPERATOR RULING 2026-08-11: the business runs on `America/Chicago`. The
 * stored `timeZone` had been left at its `America/New_York` default, which no
 * code had ever read, so nothing had ever contradicted it.
 */

/** `businessHours` is keyed by Monday-first full day names, the list Settings writes. */
const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

/**
 * The historical doc id. `getBusinessContact.ts` and `syncGoogleCalendarBusyEvents.ts`
 * both carry this same fallback: Android writes `business_settings`, web and iOS
 * historically wrote `singleton`. A phone line that reads only the modern id
 * would answer from an empty document on a tenant that never migrated.
 */
const BUSINESS_SETTINGS_DOC_LEGACY = 'business_settings/singleton';

/** Matches the "HH:MM-HH:MM" wire format `BusinessHoursEditor` writes. */
const HOURS_RANGE_RE = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/;

/**
 * What `businessHours[day]` says about one day.
 *
 * Ported deliberately from `auntieos-admin/src/lib/bookingAvailability.ts`
 * rather than imported: `auntieos-admin` and `mytribe/functions` are not
 * workspace members of each other, and Cloud Functions deploy as a
 * self-contained artifact. `closureRecurrence.ts` already exists twice in this
 * repo for the same reason.
 *
 * `unreadable` is NOT folded into open or closed. A value we cannot parse means
 * we do not know, and saying "Closed" on the strength of a failed regex is
 * exactly the authoritative-looking lie that put the phone line in this state.
 */
export type DayHours =
  | { kind: 'open'; startHHmm: string; endHHmm: string }
  | { kind: 'closed' }
  | { kind: 'unreadable'; raw: string };

/** Why the answer is what it is. Logged and asserted on, never shown to a caller. */
export type OpenReason =
  | 'open'
  | 'closed-day'
  | 'outside-hours'
  | 'company-holiday'
  | 'special-hours-unknown'
  | 'unreadable-hours'
  | 'timezone-unusable'
  | 'settings-unavailable';

export interface BusinessOpenState {
  open: boolean;
  reason: OpenReason;
  /** True when `open` is a fail-open guess rather than a hours-backed answer. Callers log these. */
  uncertain: boolean;
  /** Local `YYYY-MM-DD` in the business's zone, or '' when the zone was unusable. */
  localDateIso: string;
  /** Local `HH:mm` in the business's zone, or '' when the zone was unusable. */
  localTimeHHmm: string;
  /** "Monday" etc., or '' when the zone was unusable. */
  dayName: string;
  /** The zone actually used, echoed back so a log line is self-explaining. */
  timeZone: string;
}

/** The slice of `business_settings` this module reads. Raw document data, so every field is unknown-shaped. */
export interface BusinessHoursSettings {
  businessHours?: unknown;
  timeZone?: unknown;
  companyHolidays?: unknown;
  specialHours?: unknown;
  /**
   * ISSUE #397: whether "press 3 to talk to me right now" is offered at all.
   *
   * It lives on THIS document, and is read by THIS module, for one reason: the
   * phone handler already loads this doc once per greeting and once per
   * keypress, and a second Firestore read on a path with a 15-second Twilio
   * webhook budget would buy nothing. `resolveLiveTransferEnabled` is the
   * reader; see its comment for why absent means on.
   */
  voiceLiveTransferEnabled?: unknown;
}

/**
 * Whether the operator is currently taking live calls.
 *
 * ABSENT IS ON, and only an explicit `false` turns it off. Every settings
 * document written before this toggle existed has no field here, and the live
 * connect path has been in the deployed handler since PR #351; defaulting
 * those documents to off would withdraw the offer without anybody asking for
 * it. A failed settings read (`null`) is on for the same reason the hours fail
 * OPEN: being unable to read our own configuration is not evidence that the
 * operator has stopped answering her phone.
 *
 * THIS IS INTENT, NOT A VERDICT. It is the only half of the question this repo
 * owns. Whether a caller actually reaches a person also depends on the Twilio
 * voice credentials and on the number's "A call comes in" webhook, neither of
 * which lives in this codebase and neither of which this function can see. On
 * means "offer it", never "it is known to work".
 *
 * The consequence of the fail-open, stated plainly: if Firestore is unreachable
 * the caller is still offered the transfer, and the transfer then falls to
 * voicemail through the paths it already falls through when nobody picks up.
 * That is a worse-case of one unnecessary ring, against a worst case in the
 * other direction of a phone that quietly stops connecting anyone.
 */
export function resolveLiveTransferEnabled(settings: BusinessHoursSettings | null): boolean {
  return settings?.voiceLiveTransferEnabled !== false;
}

/** Raw document values can be anything; `mergeBusinessSettings` never descends into the hours map. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Zero-pads a "9:00" to "09:00" so plain string comparison orders times correctly. */
function padHHmm(value: string): string {
  const [h = '', m = ''] = value.split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

function isValidHHmm(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

/**
 * Reads one day out of the raw `businessHours` map.
 *
 * Every read goes through `str()` because the map's VALUES are raw document
 * data: the admin's `mergeBusinessSettings` type-checks the map itself but
 * never descends into it, so a legacy doc can hold a number here and a bare
 * `.trim()` would throw mid-call.
 */
export function businessHoursForDayName(hours: unknown, dayName: string): DayHours {
  const map = hours && typeof hours === 'object' ? (hours as Record<string, unknown>) : {};
  const raw = str(map[dayName]).trim();
  if (raw === '') return { kind: 'closed' };
  const match = HOURS_RANGE_RE.exec(raw);
  if (!match) return { kind: 'unreadable', raw };
  const startHHmm = padHHmm(match[1]!);
  const endHHmm = padHHmm(match[2]!);
  if (!isValidHHmm(startHHmm) || !isValidHHmm(endHHmm)) return { kind: 'unreadable', raw };
  return { kind: 'open', startHHmm, endHHmm };
}

export interface ZonedNow {
  dateIso: string;
  timeHHmm: string;
  dayName: string;
}

/**
 * The business's own wall clock for an instant, or null when the zone is
 * unusable.
 *
 * `Intl.DateTimeFormat` is the validation: it throws `RangeError` on an IANA
 * name it does not know, which is the only check this repo has ever applied to
 * that field. `hourCycle: 'h23'` rather than `hour12: false` because the latter
 * renders midnight as "24" under some ICU builds, which would compare above
 * every closing time and report a business open all night.
 */
export function zonedNow(nowMs: number, timeZone: string): ZonedNow | null {
  if (!timeZone.trim()) return null;
  if (!Number.isFinite(nowMs)) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'long',
    }).formatToParts(new Date(nowMs));
  } catch {
    return null;
  }
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const hour = pick('hour');
  const minute = pick('minute');
  const dayName = pick('weekday');
  if (!year || !month || !day || !hour || !minute || !dayName) return null;
  if (!DAY_NAMES.includes(dayName as (typeof DAY_NAMES)[number])) return null;
  return {
    dateIso: `${year}-${month}-${day}`,
    timeHHmm: `${hour}:${minute}`,
    dayName,
  };
}

/** Decodes `companyHolidays` with `parseClosureEntry`'s never-throws contract. */
export function parseClosureList(raw: unknown): ClosureEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string').map(parseClosureEntry);
}

/**
 * Whether a local `YYYY-MM-DD` carries a `specialHours` entry.
 *
 * `specialHours` is `"YYYY-MM-DD|hours"` where the second half is FREE TEXT the
 * editor validates only as "non-blank and contains no pipe". "10-2", "by
 * appointment", "half day" and "10:00-14:00" are all legal values that were all
 * typed by the same person. Nothing guarantees a parseable range, so this
 * deliberately reports only PRESENCE and lets the caller fail open. Regexing a
 * range out of it would work often enough to look right and fail silently the
 * rest of the time.
 */
export function hasSpecialHours(raw: unknown, dateIso: string): boolean {
  if (!Array.isArray(raw) || !dateIso) return false;
  return raw.some((entry) => typeof entry === 'string' && str(entry).split('|')[0]?.trim() === dateIso);
}

/**
 * PURE. The whole decision, given settings and an instant.
 *
 * Order is deliberate:
 *
 *  1. Timezone first, because every later rule is a wall-clock comparison and
 *     there is no meaningful wall clock without it.
 *  2. `companyHolidays` next, because a closure is the operator's own authored
 *     statement that the business is shut that day, and it outranks the weekly
 *     pattern. `guardCompanyHolidayConflict` treats it as an un-overridable
 *     hard closure for exactly this reason.
 *  3. `specialHours` before the weekly hours, because a dated exception that
 *     exists at all means the weekly pattern is known to be wrong for that day.
 *     We cannot read it, so we fail open rather than answer from a pattern the
 *     operator has already told us not to trust.
 *  4. The weekly `businessHours` entry last.
 */
export function resolveBusinessOpen(settings: BusinessHoursSettings, nowMs: number): BusinessOpenState {
  const timeZone = str(settings.timeZone).trim();
  const now = zonedNow(nowMs, timeZone);
  if (!now) {
    return {
      open: true,
      reason: 'timezone-unusable',
      uncertain: true,
      localDateIso: '',
      localTimeHHmm: '',
      dayName: '',
      timeZone,
    };
  }

  const base = {
    localDateIso: now.dateIso,
    localTimeHHmm: now.timeHHmm,
    dayName: now.dayName,
    timeZone,
  };

  for (const entry of parseClosureList(settings.companyHolidays)) {
    if (closureOccurrencesInRange(entry, now.dateIso, now.dateIso).length > 0) {
      return { ...base, open: false, reason: 'company-holiday', uncertain: false };
    }
  }

  if (hasSpecialHours(settings.specialHours, now.dateIso)) {
    return { ...base, open: true, reason: 'special-hours-unknown', uncertain: true };
  }

  const day = businessHoursForDayName(settings.businessHours, now.dayName);
  if (day.kind === 'closed') {
    return { ...base, open: false, reason: 'closed-day', uncertain: false };
  }
  if (day.kind === 'unreadable') {
    return { ...base, open: true, reason: 'unreadable-hours', uncertain: true };
  }
  // Half-open, matching `isWithinBusinessHours`: a call landing exactly at
  // opening time is inside, one landing exactly at closing time is not.
  const inside = now.timeHHmm >= day.startHHmm && now.timeHHmm < day.endHHmm;
  return {
    ...base,
    open: inside,
    reason: inside ? 'open' : 'outside-hours',
    uncertain: false,
  };
}

/**
 * Reads the settings doc, modern id first, then the legacy `singleton`.
 *
 * Returns null rather than throwing so the phone handler can fail open on a
 * Firestore fault instead of 500ing at Twilio, which would drop the caller to
 * a carrier error tone rather than a greeting.
 */
export async function loadBusinessHoursSettings(
  firestore: Firestore,
): Promise<BusinessHoursSettings | null> {
  try {
    const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
    if (snap.exists) return (snap.data() ?? {}) as BusinessHoursSettings;
    const legacy = await firestore.doc(BUSINESS_SETTINGS_DOC_LEGACY).get();
    if (legacy.exists) return (legacy.data() ?? {}) as BusinessHoursSettings;
    return null;
  } catch {
    return null;
  }
}

/**
 * The one call the phone handler makes. A missing or unreadable settings doc
 * fails OPEN, because being unable to read our own hours is not evidence that
 * we are shut.
 */
export async function resolveBusinessOpenNow(
  firestore: Firestore,
  nowMs: number,
): Promise<BusinessOpenState> {
  return resolveBusinessOpenFromSettings(await loadBusinessHoursSettings(firestore), nowMs);
}

/**
 * The same answer, from settings a caller has ALREADY loaded.
 *
 * Split out of `resolveBusinessOpenNow` so a caller that needs more than the
 * hours out of this document — `twilioVoice`, which also needs
 * `voiceLiveTransferEnabled` — can read it once and ask both questions, rather
 * than loading the same document twice inside one phone call. The null branch
 * lives here rather than at each call site so "we could not read our settings"
 * keeps exactly one definition of what it means.
 */
export function resolveBusinessOpenFromSettings(
  settings: BusinessHoursSettings | null,
  nowMs: number,
): BusinessOpenState {
  if (!settings) {
    return {
      open: true,
      reason: 'settings-unavailable',
      uncertain: true,
      localDateIso: '',
      localTimeHHmm: '',
      dayName: '',
      timeZone: '',
    };
  }
  return resolveBusinessOpen(settings, nowMs);
}
