import { rec, str } from './coerce';
import { type ActivityLogEntry } from '../api/activityLog';
import { type StaffRole } from '../api/staff';
import { businessInstantMs, businessWallClock } from './businessZoneTime';
import { DEFAULT_BUSINESS_TIME_ZONE } from './businessOperations';
import { formatTime } from './denFormat';
import { activityDescriptionWords } from './activityWords';

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
 * The full ISO `timestamp` leads, not the `HH:mm` slice the collapsed row shows:
 * the whole point of opening an entry is to see the parts the row truncates, and
 * "which second" is routinely the question when reconciling an audit trail
 * against a provider's logs.
 */
export function activityDetailRows(
  entry: ActivityLogEntry,
  zone: string = DEFAULT_BUSINESS_TIME_ZONE,
  /** uid -> name (`useStaffNames`), #1592. A uid it does not know shows as it is. */
  names: ReadonlyMap<string, string> = new Map(),
  /** uid -> 'owner' | 'auntie' (`useStaffRoles`), #1820. See `actorRoleFor`. */
  roles: ReadonlyMap<string, StaffRole> = new Map(),
): ActivityDetailRow[] {
  const rows: ActivityDetailRow[] = [];
  const push = (label: string, value: string): void => {
    if (value.trim() !== '') rows.push({ label, value });
  };

  push('When', str(entry.timestamp));
  // The stored stamp is UTC; the row above it reads in the business zone (#1585).
  // Showing both is what lets someone reconcile the two without doing the sum.
  const when = activityWhen(str(entry.timestamp), zone);
  if (when !== null) push('Business time', `${when.dayKey} ${when.clock}`);
  push('Action', str(entry.actionType));
  push('Status', str(entry.status));
  push('Severity', str(entry.severity));
  // #1592: the person by name. The uid stays on the opened record beside it,
  // because this is the evidence log and the uid is what the record holds.
  const actorId = str(entry.actorId).trim();
  const actorName = names.get(actorId);
  push('Actor', actorName ?? actorId);
  if (actorName !== undefined) push('Actor id', actorId);
  push('Actor role', actorRoleFor(entry, roles));
  push('Household', str(entry.familyId));
  // A path, not a link. Where a route exists the screen offers one separately;
  // where none does, the path is still the most useful thing that can honestly
  // be shown (page-spec 22 item 1: "render the path read-only, do not fabricate
  // a link").
  const target = str(entry.targetId);
  if (target !== '') push('Target', `${str(entry.targetCollection) || 'target'}/${target}`);
  push('Request', str(entry.requestId));
  push('Client request', str(entry.clientRequestId));
  push('IP', str(entry.ip));
  push('User agent', str(entry.userAgent));
  return rows;
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
export function activityPayloadRows(entry: ActivityLogEntry): ActivityDetailRow[] {
  const out: ActivityDetailRow[] = [];

  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      // Arrays render as one line: an audit payload's arrays are short lists
      // (channel names, ids), and exploding them into `channels.0` / `channels.1`
      // buries the fact that they are one field.
      out.push({ label: path, value: value.map((v) => renderScalar(v)).join(', ') });
      return;
    }
    if (typeof value === 'object' && value !== null) {
      const map = value as Record<string, unknown>;
      const keys = Object.keys(map).sort();
      // An empty nested map is reported rather than dropped: "this field is here
      // and it is empty" is a different fact from "this field is absent", and in
      // an audit trail the difference can matter.
      if (keys.length === 0) {
        out.push({ label: path, value: '{}' });
        return;
      }
      for (const k of keys) walk(map[k], path === '' ? k : `${path}.${k}`);
      return;
    }
    out.push({ label: path, value: renderScalar(value) });
  };

  const payload = rec(entry.payload);
  for (const k of Object.keys(payload).sort()) walk(payload[k], k);
  return out;
}

/**
 * A leaf value as text. A recorded null prints as "none" rather than blank,
 * because it is a decision the writer made and blanking it would hide that; it
 * is a word rather than the literal "null" because an operator reads it (#1592).
 */
function renderScalar(v: unknown): string {
  if (v === null) return 'none';
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // A Firestore Timestamp or anything else exotic. Never `String(obj)`, which
  // yields "[object Object]" and tells a reader nothing.
  return JSON.stringify(v);
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
    str(entry.actorId),
    names.get(str(entry.actorId).trim()) ?? '',
    str(entry.actorRole),
    str(entry.targetId),
    str(entry.targetCollection),
    str(entry.status),
    str(entry.severity),
    ...activityPayloadRows(entry).map((r) => `${r.label} ${r.value}`),
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
/** `KINCARE_ARRIVED` reads as "Kincare arrived": the mock's bold line. Mirrors Android's `humanizeAction`. */
export function humanizeAction(actionType: string): string {
  const lower = actionType.toLowerCase().replace(/_/g, ' ').trim();
  return lower === '' ? 'Event' : lower.charAt(0).toUpperCase() + lower.slice(1);
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
 * The row's bold line. A kind with a plain title (#1839) shows that title and no
 * stored key beside it; every other kind keeps the humanized key and its code.
 * Same rule as Android and the desktop console (`activityTitle`).
 */
export function activityTitle(actionType: string): string {
  return actionType.trim().toUpperCase() === HOUSEHOLD_LOOK_ACTION ? HOUSEHOLD_LOOK_TITLE : humanizeAction(actionType);
}

/** Whether the row prints the stored key beside its title. False for a kind with a plain title. */
export function activityShowsCode(actionType: string): boolean {
  return actionType.trim() !== '' && activityTitle(actionType) === humanizeAction(actionType);
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
