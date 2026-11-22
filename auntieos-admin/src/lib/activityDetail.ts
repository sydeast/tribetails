import { rec, str } from './coerce';
import { type ActivityLogEntry } from '../api/activityLog';
import { type StaffRole } from '../api/staff';
import { businessInstantMs, businessWallClock } from './businessZoneTime';
import { DEFAULT_BUSINESS_TIME_ZONE } from './businessOperations';
import { formatTime } from './denFormat';
import { activityDescriptionWords, activityTitleWords, brandWords, noticeNotSentWords } from './activityWords';

/**
 * What an Activity Log row shows when it is OPENED.
 *
 * Operator ruling R5, on the Activity Log itself: "the Activity Log is seriously
 * lacking, cant see shit or what the fuck actually happened."
 *
 * That is not a data problem, which is the surprising part. `writeAuditEntry`
 * has sealed `severity`, `actorRole`, `familyId`, `payload`, `requestId`, `ip`
 * and `userAgent` into every entry since 2026-05-19, and its docstring says
 * outright that they are "retained for forensic value ... surfaced in detail
 * views". No detail view was ever built. So the screen rendered four of the
 * eleven fields it had, and `payload` (the field that actually says what happened)
 * was never rendered anywhere, and page-spec 22 item 1 has carried "rows aren't
 * clickable / no detail view" as the core complaint since 2026-05-27.
 *
 * PURE, so the decisions get tested without a renderer. Nothing here fetches,
 * resolves or reformats: the audit trail is EVIDENCE, and a detail view that
 * prettied its contents would be editing the record on the way to the reader.
 * The one transformation applied is flattening nested payload maps to dotted
 * paths, which is presentation of structure, not of content.
 */

/** One labelled line in an opened entry. */
export interface ActivityDetailRow {
  label: string;
  value: string;
}

/**
 * The identity + provenance fields, in a fixed order, absent ones dropped.
 *
 * #1818: in words. The opened entry used to list the stored key ("ACTION
 * CANCEL_BOOKING_SERIES"), the actor's uid, the household's id, the target's
 * database path, request ids, and the raw UTC stamp beside the business time.
 * Now it is one readable time, the person and the household by name, and the
 * status and severity in words. The ids stay on the sealed entry, and the
 * search box still finds a row by them.
 */
export function activityDetailRows(
  entry: ActivityLogEntry,
  zone: string = DEFAULT_BUSINESS_TIME_ZONE,
  /** uid -> name (`useStaffNames`), #1592. Only a real name is shown, never an email or a uid. */
  names: ReadonlyMap<string, string> = new Map(),
  /** uid -> 'owner' | 'auntie' (`useStaffRoles`), #1820. See `actorRoleFor`. */
  roles: ReadonlyMap<string, StaffRole> = new Map(),
  /** household id -> name (the Kinfolk roster), #1818. A household it does not hold is left out. */
  households: ReadonlyMap<string, string> = new Map(),
): ActivityDetailRow[] {
  const rows: ActivityDetailRow[] = [];
  const push = (label: string, value: string): void => {
    if (value.trim() !== '') rows.push({ label, value });
  };
  // The stored stamp is UTC; it reads in the business zone (#1585), once.
  const when = activityWhen(str(entry.timestamp), zone);
  push('When', when !== null ? activityWhenWords(when) : '');
  push('Status', activityStatusWords(entry));
  push('Severity', severityWords(str(entry.severity)));
  push('Actor', activityActorName(entry, names));
  push('Actor role', actorRoleFor(entry, roles));
  push('Household', households.get(str(entry.familyId).trim()) ?? '');
  push('IP', str(entry.ip));
  push('User agent', str(entry.userAgent));
  return rows;
}

/** `Nov 11, 2026, 11:33a`: an entry's time as the opened entry reads it (#1818). */
export function activityWhenWords(when: ActivityWhen): string {
  const month = MONTHS[Number(when.dayKey.slice(5, 7)) - 1] ?? when.dayKey.slice(5, 7);
  return `${month} ${String(Number(when.dayKey.slice(8, 10)))}, ${when.dayKey.slice(0, 4)}, ${when.clock}`;
}

const SEVERITY_WORDS: Readonly<Record<string, string>> = { info: 'Info', warn: 'Warning', critical: 'Critical' };
function severityWords(raw: string): string {
  const s = raw.trim().toLowerCase();
  return s === '' ? '' : (SEVERITY_WORDS[s] ?? brandWords(s));
}

/**
 * #1818: the actor's name, or nothing. The roster's label falls back to a
 * sign-in email and then the uid, and neither belongs on screen; nor does the
 * uid the row showed before the roster answered.
 */
export function activityActorName(entry: ActivityLogEntry, names: ReadonlyMap<string, string>): string {
  const actor = str(entry.actorId).trim();
  if (actor === '') return '';
  const name = (names.get(actor) ?? '').trim();
  return name === '' || name === actor || name.includes('@') ? '' : name;
}

/**
 * #1818: who did it, as the collapsed row says it: the person's name, or the
 * role they held ("Operator", "Auntie", "Primary kinfolk", "System") when the
 * roster has no name for them. Never an email or a uid.
 */
export function activityActorWords(
  entry: ActivityLogEntry,
  names: ReadonlyMap<string, string>,
  roles: ReadonlyMap<string, StaffRole> = new Map(),
): string {
  const name = activityActorName(entry, names);
  if (name !== '') return name;
  if (str(entry.actorId).trim() === '' && str(entry.actorRole).trim() === '') return '';
  return actorRoleFor(entry, roles);
}

/**
 * The chain seal, or an empty array for a legacy pre-chain entry.
 *
 * Kept apart from the fields above because it answers a different question: not
 * "what happened" but "can this record be trusted". The screen renders it under
 * its own heading for the same reason.
 *
 * The FULL hashes, never a `.slice(0, 8)` prefix. The collapsed row abbreviates
 * because it has one line; an opened entry is where someone verifies a hash by
 * eye against `verifyActivityLogChain`, and a truncated hash cannot be verified
 * against anything.
 */
export function activityChainRows(entry: ActivityLogEntry): ActivityDetailRow[] {
  if (entry.seq === undefined) return [];
  const rows: ActivityDetailRow[] = [{ label: 'Sequence', value: `#${String(entry.seq)}` }];
  const entryHash = str(entry.entryHash);
  const prevHash = str(entry.prevHash);
  if (entryHash !== '') rows.push({ label: 'Entry hash', value: entryHash });
  if (prevHash !== '') rows.push({ label: 'Previous hash', value: prevHash });
  return rows;
}

/**
 * The `payload` map, flattened to dotted paths and sorted.
 *
 * THIS IS THE FIELD THAT ANSWERS "what the fuck actually happened", and it was
 * rendered nowhere. A NOTIFICATION_RECEIVED entry's description reads
 * "Notification kincare.booking.confirm delivered via email"; its payload
 * carries the notification id, the recipient uid and the provider's message id.
 * A BOOKING_SUBMITTED entry's payload carries the household, the batch and the
 * visit count. Same for every other event type: each one puts the specifics
 * here, because `writeAuditEntry` gives it nowhere else to put them.
 *
 * FLATTENED, not JSON-dumped. `sortDeep` in writeAuditEntry already sorts these
 * keys at write time (it has to: the hash is computed over the canonical form),
 * so a nested map arrives in a stable order and a dotted path is a stable label.
 * A pretty-printed JSON blob would be shorter to write and much worse to read.
 *
 * Sorted so two entries of the same type list their fields in the same order,
 * which is what makes them comparable by eye.
 */
export function activityPayloadRows(
  entry: ActivityLogEntry,
  zone: string = DEFAULT_BUSINESS_TIME_ZONE,
): ActivityDetailRow[] {
  const out: ActivityDetailRow[] = [];
  const walk = (value: unknown, path: string, leaf: string): void => {
    // #1818: an id, a stored key, a hash or a path is not shown. It stays on
    // the sealed entry, and the search box still finds the row by it.
    if (isHiddenPayloadKey(leaf)) return;
    if (Array.isArray(value)) {
      // Arrays render as one line: an audit payload's arrays are short lists
      // (channel names, ids), and exploding them into `channels.0` / `channels.1`
      // buries the fact that they are one field.
      const items = value.map((v) => renderScalar(v, zone)).filter((v) => v !== '' && !looksLikeId(v));
      if (items.length > 0) out.push({ label: payloadLabel(path), value: items.join(', ') });
      return;
    }
    if (typeof value === 'object' && value !== null) {
      const map = value as Record<string, unknown>;
      const keys = Object.keys(map).sort();
      for (const k of keys) walk(map[k], path === '' ? k : `${path}.${k}`, k);
      return;
    }
    const text = renderScalar(value, zone);
    if (text === '' || looksLikeId(text)) return;
    out.push({ label: payloadLabel(path), value: text });
  };
  const payload = rec(entry.payload);
  for (const k of Object.keys(payload).sort()) walk(payload[k], k, k);
  return out;
}

/** `affectedVisits` reads "Affected visits"; `result.scanned` reads "Result scanned". */
function payloadLabel(path: string): string {
  return brandWords(path.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
}

/** A key whose value is an id, a stored key, a hash or a database path (#1818). */
function isHiddenPayloadKey(key: string): boolean {
  return /(?:^|[a-z0-9])(?:Id|Ids|Uid|Uids|Key|Keys|Hash|Path)$/.test(key) || /^(?:id|ids|uid|uids|key|keys|hash|path|admin|staffRole|code)$/i.test(key);
}

/**
 * A value that is an id or a path rather than words (#1818): a stored id with
 * a prefix (`vis_...`, `req_...`), a long run of letters and digits, or a path.
 */
function looksLikeId(text: string): boolean {
  const t = text.trim();
  if (/\s/.test(t)) return false;
  if (/^[A-Za-z]{2,6}_[A-Za-z0-9_-]{8,}$/.test(t)) return true;
  if (/^[A-Za-z0-9_-]{16,}$/.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t)) return true;
  return /^[\w-]+(?:\/[\w-]+)+$/.test(t);
}

/**
 * A leaf value as text. A recorded null prints as "none" rather than blank,
 * because it is a decision the writer made and blanking it would hide that; it
 * is a word rather than the literal "null" because an operator reads it (#1592).
 */
function renderScalar(v: unknown, zone: string = DEFAULT_BUSINESS_TIME_ZONE): string {
  if (v === null) return 'none';
  if (v === undefined) return '';
  if (typeof v === 'string') return valueWords(v, zone);
  if (typeof v === 'number' || typeof v === 'boolean') return v === true ? 'yes' : v === false ? 'no' : String(v);
  // A Firestore Timestamp or anything else exotic. Never `String(obj)`, which
  // yields "[object Object]" and tells a reader nothing.
  return JSON.stringify(v);
}

/**
 * #1818: a stored value in words. A time reads in the business zone, a stored
 * status or key (`SCHEDULED`, `kincare.booking.confirm`) reads as words.
 */
function valueWords(raw: string, zone: string): string {
  const t = raw.trim();
  const when = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t) ? activityWhen(t, zone) : null;
  if (when !== null) return activityWhenWords(when);
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]{3,}$/.test(t)) return brandWords(t);
  if (/^[a-z]+(?:\.[a-z_]+)+$/.test(t)) return brandWords(t);
  if (/^[a-z]+(?:_[a-z]+)+$/.test(t)) return brandWords(t);
  return raw;
}

/**
 * Free-text search over an entry, for the screen's filter box.
 *
 * Searches the payload too, which is the part that makes it useful: "find the
 * entry mentioning this booking id" is the actual question an operator has, and
 * the id is almost always in the payload rather than in the description.
 */
export function activityMatchesQuery(
  entry: ActivityLogEntry,
  query: string,
  /** #1592: so the actor can be found by the name the row shows. */
  names: ReadonlyMap<string, string> = new Map(),
): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const haystack = [
    str(entry.actionType),
    // #1839: the plain title the row shows in place of the key.
    activityTitle(str(entry.actionType)),
    str(entry.description),
    // #1747: the words the row shows, so a search for them finds a stored path's row.
    activityDescriptionWords(str(entry.description)),
    // #1819: a held notice's title and sentence, as the row shows them.
    activityEntryTitle(entry),
    activityEntryDescription(entry),
    activityStatusWords(entry),
    str(entry.actorId),
    names.get(str(entry.actorId).trim()) ?? '',
    str(entry.actorRole),
    str(entry.targetId),
    str(entry.targetCollection),
    str(entry.status),
    str(entry.severity),
    str(entry.familyId),
    ...activityPayloadRows(entry).map((r) => `${r.label} ${r.value}`),
    // #1818: the ids the screen no longer shows still find their row.
    JSON.stringify(rec(entry.payload)),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/**
 * The status buckets the filter chips offer.
 *
 * 'problems' folds FAILURE and ERROR together because an operator scanning for
 * trouble does not care which spelling a given writer used, and both are in the
 * data (writeAuditEntry only emits SUCCESS/FAILURE/PENDING, but pre-2026-05-19
 * rows carry ERROR).
 */
export type ActivityStatusFilter = 'all' | 'problems' | 'success' | 'pending';

export function activityMatchesStatus(
  entry: ActivityLogEntry,
  filter: ActivityStatusFilter,
): boolean {
  if (filter === 'all') return true;
  // #1819: a notice that did not go out is not a success, whatever an older
  // writer stored on it.
  if (activityIsNoticeNotSent(entry) && !activityIsFailure(entry)) return false;
  const s = str(entry.status).trim().toUpperCase();
  if (filter === 'problems') return s === 'FAILURE' || s === 'ERROR';
  if (filter === 'success') return s === 'SUCCESS';
  return s === 'PENDING';
}

// ── the collapsed row, per the mock ──────────────────────────────────────────
//
// Issue #755 (mock `auntieos-activity-log-2026-05-27.html`): a row reads as
// time, a category glyph, a humanised title with the raw code beside it, and
// the day separators say "Today · May 27". Android's ActivityLogScreen has drawn
// all of this since its Den port; these are the same decisions, made once and
// tested here so the two clients cannot label the same entry differently.

/**
 * The filter chips: the mock's six plus Billing (#1613).
 *
 * A category is a PARTITION: every action type lands under exactly one chip,
 * chosen by the first rule below that claims it, so the filter and the row's tile
 * can never disagree and a billing event cannot sit under KinTales. It used to be
 * a set of overlapping substring questions ("DRAFT" was KinTales, so
 * BILLING_DRAFT_INVOICE_SENT filed there), and Admin matched almost nothing
 * because the real admin events (THEME_*, MEMBERSHIP_*, PERM_*, RETENTION_*, ...)
 * were never listed. Android and the desktop console carry the same rules, in the
 * same order; change all three together.
 */
export type ActivityCategory = 'all' | 'auth' | 'bookings' | 'kintales' | 'notifications' | 'billing' | 'admin';
type RealCategory = Exclude<ActivityCategory, 'all'>;
const startsWithAny = (a: string, prefixes: readonly string[]): boolean => prefixes.some((p) => a.startsWith(p));
const includesAny = (a: string, needles: readonly string[]): boolean => needles.some((n) => a.includes(n));
/** First match wins, so the order is part of the contract. Money first: it must never fall to a later, broader rule. */
const CATEGORY_RULES: readonly (readonly [RealCategory, (a: string) => boolean])[] = [
  ['billing', (a) => startsWithAny(a, ['BILLING_', 'EXPENSE_']) || includesAny(a, ['INVOICE', 'PAYMENT', 'QUOTE'])],
  ['auth', (a) => startsWithAny(a, ['AUTH', 'SECRETS_']) || includesAny(a, ['LOGIN', 'LOGOUT'])],
  [
    'notifications',
    (a) =>
      includesAny(a, ['NOTIFICATION', 'NOTIF']) ||
      startsWithAny(a, ['CONVERSATION', 'EXTERNAL_MESSAGE', 'BROADCAST', 'MARKETING_BLAST']),
  ],
  [
    'admin',
    (a) =>
      startsWithAny(a, [
        'ADMIN', 'UPDATE_SETTINGS', 'SETTINGS', 'THEME_', 'MEMBERSHIP_', 'PERM_', 'SAVE_FORM_SCHEMA',
        'DELETE_FORM_SCHEMA', 'BUSINESS_', 'BRANDING_', 'EMAIL_FRAME_', 'VET_CLINIC_', 'CREATE_KINFOLK',
        'ARCHIVE_KIN', 'RESTORE_KIN', 'KIN_REMOVAL', 'CREATE_TRAINING', 'UPDATE_TRAINING', 'DELETE_TRAINING',
        'SUPPL', 'EXPIRATION_', 'INTEGRATION_', 'AUDIENCE_SEGMENT', 'EXTERNAL_SUPPRESSION', 'OPERATOR_',
        'RETENTION_', 'ERROR_', 'PROFILE_', 'HOME_ACCESS', 'EMERGENCY_CONTACT',
        // #1820: Kinfolk and Kin record edits, and email and message templates.
        'UPDATE_KINFOLK', 'UPDATE_KIN_TAGS', 'SECONDARY_KINFOLK', 'HOUSEHOLD_DATA', 'TEMPLATE_',
      ]) ||
      // Exact, never a prefix: CREATE_KINCARE_SESSION and UPDATE_KINCARE_SESSION are Bookings.
      a === 'CREATE_KIN' ||
      a === 'UPDATE_KIN' ||
      a.includes('TRIAGE'),
  ],
  [
    'kintales',
    (a) => startsWithAny(a, ['CONTENT_', 'MEDIA_']) || includesAny(a, ['KINTALE', 'TALE_', 'DRAFT', 'REPORT']),
  ],
  [
    'bookings',
    (a) => includesAny(a, ['BOOKING', 'KINCARE', 'SESSION', 'VISIT', 'RESCHEDULE', 'BLOCKED_TIME_SLOT', 'CANCEL_REQUEST']),
  ],
];
/** The one category an entry belongs to, or null for an action nothing claims (it still shows under All). */
export function activityCategoryOf(entry: ActivityLogEntry): RealCategory | null {
  const a = str(entry.actionType).toUpperCase();
  return CATEGORY_RULES.find(([, claims]) => claims(a))?.[0] ?? null;
}

export function activityMatchesCategory(entry: ActivityLogEntry, category: ActivityCategory): boolean {
  return category === 'all' || activityCategoryOf(entry) === category;
}

/**
 * `KINCARE_ARRIVED` reads as "KinCare arrived": the mock's bold line, brand
 * words in their casing (#1881). Mirrors Android's `humanizeAction`.
 */
export function humanizeAction(actionType: string): string {
  const words = brandWords(actionType);
  return words === '' ? 'Event' : words;
}

/**
 * #1839: the stored key of a look at a household. Since operator ruling
 * 2026-11-12 only an Auntie's looks write it; rows stored before then carry the
 * owner's looks too. It is a routine look, never a warning.
 */
export const HOUSEHOLD_LOOK_ACTION = 'OPERATOR_CROSSTENANT_ACCESS';
export const HOUSEHOLD_LOOK_TITLE = 'Household opened';

/** Is this entry a look at a household (#1839)? */
export function activityIsHouseholdLook(entry: ActivityLogEntry): boolean {
  return str(entry.actionType).trim().toUpperCase() === HOUSEHOLD_LOOK_ACTION;
}

/**
 * The row's bold line: the kind's plain title, or its key in words (#1818,
 * #1881). The stored key itself is never on screen. Same rule as Android and
 * the desktop console (`activityTitle`).
 */
export function activityTitle(actionType: string): string {
  return activityTitleWords(actionType);
}
// ── a notice that did not go out (#1819, #1905) ──────────────────────────────
//
// The server writes `NOTIFICATION_NOT_SENT` with status `NOT_SENT` and a
// sentence that says who and why. Before that it wrote a held notice as
// `NOTIFICATION_DISPATCHED`, status SUCCESS, with the reason as a stored key in
// the payload. Stored rows are evidence and are never rewritten, so the row
// reads them as what they were: not sent. Android and the desktop console
// carry the same rules (`ActivityLogScreen.kt`); change all three together.
export const NOTICE_NOT_SENT_ACTION = 'NOTIFICATION_NOT_SENT';
export const NOTICE_NOT_SENT_TITLE = 'Notification not sent';
export const NOT_SENT_STATUS_WORDS = 'Not sent';
/** The held notice an older server stored as "dispatched": a reason, and nothing dispatched. */
function isLegacyHeldNotice(entry: ActivityLogEntry): boolean {
  if (str(entry.actionType).trim().toUpperCase() !== 'NOTIFICATION_DISPATCHED') return false;
  const payload = rec(entry.payload);
  const ids = payload['dispatchIds'];
  return str(payload['reason']).trim() !== '' && Array.isArray(ids) && ids.length === 0;
}

/** Is this entry a notice that did not go out, in either stored form? */
export function activityIsNoticeNotSent(entry: ActivityLogEntry): boolean {
  return str(entry.actionType).trim().toUpperCase() === NOTICE_NOT_SENT_ACTION || isLegacyHeldNotice(entry);
}

/** The row's bold line for this entry: `activityTitle`, except a held notice stored as "dispatched". */
export function activityEntryTitle(entry: ActivityLogEntry): string {
  return isLegacyHeldNotice(entry) ? NOTICE_NOT_SENT_TITLE : activityTitle(str(entry.actionType));
}

/** The row's sentence: the stored description in words, or the held notice's reason in words. */
export function activityEntryDescription(entry: ActivityLogEntry): string {
  if (isLegacyHeldNotice(entry)) {
    const payload = rec(entry.payload);
    return noticeNotSentWords(str(payload['key']), str(payload['reason']));
  }
  return activityDescriptionWords(str(entry.description));
}

/** The status the opened entry shows. "Not sent" for a notice that did not go out and did not fail. */
export function activityStatusWords(entry: ActivityLogEntry): string {
  const status = str(entry.status);
  const s = status.trim().toUpperCase();
  if (s === 'NOT_SENT') return NOT_SENT_STATUS_WORDS;
  if (isLegacyHeldNotice(entry) && s === 'SUCCESS') return NOT_SENT_STATUS_WORDS;
  // #1818: the stored status in words.
  return STATUS_WORDS[s] ?? brandWords(status);
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  SUCCESS: 'Done',
  FAILURE: 'Failed',
  ERROR: 'Failed',
  PENDING: 'Pending',
};

/**
 * The collapsed row's grey line (#1818): the sentence, then who did it. No
 * database path, no id, no email. A sentence that only repeats the title is
 * left off; a stored "<KEY> uid=<id>" reads as nothing for the same reason.
 */
export function activityRowContext(
  entry: ActivityLogEntry,
  names: ReadonlyMap<string, string> = new Map(),
  roles: ReadonlyMap<string, StaffRole> = new Map(),
): string {
  const parts: string[] = [];
  const description = activityEntryDescription(entry).trim();
  const title = activityEntryTitle(entry).trim();
  if (description !== '' && description.toLowerCase() !== title.toLowerCase()) parts.push(description);
  if (activityIsHouseholdLook(entry)) {
    // #1839: a look the server wrote in words already names the Auntie and the
    // household. A look stored as the bare key names nobody, so it keeps the name.
    const namedInWords = description !== '' && description === str(entry.description).trim();
    const who = namedInWords ? '' : activityActorName(entry, names);
    if (who !== '') parts.push(who);
    return parts.join(' · ');
  }
  const who = activityActorWords(entry, names, roles);
  if (who !== '') parts.push(who);
  return parts.join(' · ');
}

/** True when the wire status is a failure, in either spelling the writers have used. */
export function activityIsFailure(entry: ActivityLogEntry): boolean {
  const s = str(entry.status).trim().toUpperCase();
  return s === 'FAILURE' || s === 'ERROR';
}

/**
 * The mock's `.daysep`: "Today · May 27", "Yesterday · May 26", then "May 24".
 *
 * `today` is INJECTED as a `YYYY-MM-DD` key rather than read from the clock so
 * the label is a pure function; the screen passes its own local day. A key that
 * is not a date ("Undated") is returned as it came.
 */
export function activityDayLabel(day: string, today: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? day.slice(5, 7);
  // #1599: the log spans more than a year, so a day from another year says which.
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  const monthDay = `${month} ${String(Number(day.slice(8, 10)))}`;
  if (day === today) return `Today · ${monthDay}`;
  if (day === dayBefore(today)) return `Yesterday · ${monthDay}`;
  return sameYear ? monthDay : `${monthDay}, ${day.slice(0, 4)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A log timestamp read on the business's calendar: its day key and its compact clock ("9:34p"). */
export interface ActivityWhen {
  dayKey: string;
  clock: string;
}

/**
 * Reads a log timestamp in the BUSINESS zone (#1585), never the device's and
 * never the UTC wall clock the string happens to carry. A stamp with a zone
 * (`...Z`, `+05:00`) is an instant; one without is already the business's wall
 * clock (the same reading `businessInstantMs` gives visit times). Null when the
 * string has no readable date and time, so the caller can say "Undated" instead
 * of inventing one.
 */
export function activityWhen(timestamp: string, zone: string = DEFAULT_BUSINESS_TIME_ZONE): ActivityWhen | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(timestamp)) return null;
  const ms = businessInstantMs(timestamp, zone);
  if (ms === null) return null;
  const wc = businessWallClock(ms, zone);
  return { dayKey: wc.dateIso, clock: formatTime(`${wc.dateIso}T${wc.hhmm}`) };
}

/** Local `YYYY-MM-DD` for a Date, the shape `activityDayLabel` compares against. */
export function localDayKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayBefore(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const d = new Date(
    Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) - 1),
  );
  return d.toISOString().slice(0, 10);
}

/**
 * The audit trail's actor role in words (#1592). The server writes `AUNTIE` for
 * every staff caller, the owner included, so it reads "Staff", never "Auntie";
 * PRIMARY and SECONDARY are the household's kinfolk. Display only: the stored
 * value, and the search over it, are unchanged. Blank stays blank so the row is
 * dropped.
 */
export function actorRoleLabel(role: string): string {
  const key = role.trim().toUpperCase();
  switch (key) {
    case '':
      return '';
    case 'AUNTIE':
      return 'Staff';
    case 'PRIMARY':
      return 'Primary kinfolk';
    case 'SECONDARY':
      return 'Secondary kinfolk';
    case 'SYSTEM':
      return 'System';
    default: {
      const words = key.toLowerCase().split(/[_\s]+/).filter(Boolean).join(' ');
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

/** The owner, in the word the page header uses for that account. */
export const OWNER_ROLE_LABEL = 'Operator';
/** A caretaker, in the word the page header uses for that account. */
export const AUNTIE_ROLE_LABEL = 'Auntie';

/**
 * The role an entry's actor held, in the words the page header uses for the
 * same account (#1820): "Operator" for the owner, "Auntie" for a caretaker.
 *
 * The stored role cannot say that on its own. The server files the owner and a
 * caretaker under one value, and until #1820 every line a client asked for was
 * stored as PRIMARY, so the owner's clock taps read "Primary kinfolk". Three
 * sources, in order:
 *
 *   1. What the server stamped on the entry when it wrote it (`payload.admin`,
 *      `payload.staffRole`), on a staff entry. That is the role held at the
 *      time, so it wins.
 *   2. The staff roster (`roles`), by the actor's uid, whatever role is stored.
 *      This is what corrects the entries already stored with the wrong role.
 *   3. The stored role, through `actorRoleLabel`.
 *
 * A System entry is never relabelled, and an actor the roster does not hold
 * keeps the stored role. Display only: the entry is sealed and never rewritten.
 */
export function actorRoleFor(
  entry: ActivityLogEntry,
  roles: ReadonlyMap<string, StaffRole> = new Map(),
): string {
  const stored = str(entry.actorRole).trim().toUpperCase();
  if (stored === 'SYSTEM') return actorRoleLabel(stored);
  if (stored === 'AUNTIE') {
    const payload = rec(entry.payload);
    if (payload.staffRole === 'auntie') return AUNTIE_ROLE_LABEL;
    if (payload.admin === true) return OWNER_ROLE_LABEL;
  }
  const onRoster = roles.get(str(entry.actorId).trim());
  if (onRoster === 'owner') return OWNER_ROLE_LABEL;
  if (onRoster === 'auntie') return AUNTIE_ROLE_LABEL;
  return actorRoleLabel(stored);
}
