import { db, getAdmin } from './firestoreAdmin';
import { logEvent } from './logger';

/**
 * The name a screen shows for a staff uid (#1564).
 *
 * `staff/{uid}` is the record the business admin roster, the Assigned Auntie
 * picker (Bookings > Choose an Auntie) and the Gallery's uploader line read. On
 * the 2026-11-05 walk the only business admin had a staff record with no name
 * and no email, so all three showed a bare uid.
 *
 * The name is, in order: the staff record's name, the Firebase Auth account's
 * display name, then an email (the record's, then the sign-in one). A uid is
 * never the answer while any of those exists.
 *
 * NAME ONLY. Operator ruling, 2026-11-05 docket: every business email goes to
 * the business contact email in business settings, so the sign-in email here is
 * a label and never an address anything is sent to. `email` stays the staff
 * record's own value.
 *
 * The record is never written here.
 */

export interface StaffIdentity {
  uid: string;
  /** The name to show. Null only when no source has a name or an email. */
  displayName: string | null;
  /** The staff record's email, as stored. Null when it has none. */
  email: string | null;
  /** False when no `staff/{uid}` document exists. */
  hasStaffRecord: boolean;
}

type StaffRecord = { displayName?: unknown; email?: unknown };

/** `getUsers` takes at most 100 identifiers per call. */
const AUTH_BATCH = 100;

function trimmed(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The sign-in name and email for each uid, or an empty map when Auth cannot be
 * read. A failed lookup is logged and costs only the fallback: the caller still
 * answers from the staff records it has.
 */
export async function signInIdentities(
  uids: readonly string[],
  context: string,
): Promise<Map<string, { displayName: string; email: string }>> {
  const out = new Map<string, { displayName: string; email: string }>();
  const unique = [...new Set(uids.filter((u) => u.length > 0))];
  for (let i = 0; i < unique.length; i += AUTH_BATCH) {
    const batch = unique.slice(i, i + AUTH_BATCH);
    try {
      const res = await getAdmin().auth().getUsers(batch.map((uid) => ({ uid })));
      for (const user of res.users) {
        out.set(user.uid, { displayName: trimmed(user.displayName), email: trimmed(user.email) });
      }
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'staffIdentity',
        event: 'staffIdentity.signInLookupFailed',
        errorMessage: err instanceof Error ? err.message : String(err),
        extra: { context, count: batch.length },
      });
    }
  }
  return out;
}

/** Merges one staff record with the sign-in account. Pure, so it is tested directly. */
export function mergeIdentity(
  uid: string,
  record: StaffRecord | undefined,
  signIn: { displayName: string; email: string } | undefined,
): StaffIdentity {
  const recordEmail = trimmed(record?.email);
  const name =
    trimmed(record?.displayName) || signIn?.displayName || recordEmail || signIn?.email || '';
  return {
    uid,
    displayName: name || null,
    email: recordEmail || null,
    hasStaffRecord: record !== undefined,
  };
}

function looksLikeEmail(s: string): boolean {
  return s.includes('@');
}

/**
 * #1857: a staff member's NAME and nothing else: the staff record's name, else
 * the sign-in account's display name. Never an email and never the uid, so it
 * is safe to store on a record a household reads (`auntieDisplayName` on a
 * visit). A "name" that is itself an email counts as no name. Null when there
 * is none, and the screen then says who it is in its own words.
 */
export function staffNameOnly(
  record: StaffRecord | undefined,
  signIn: { displayName: string } | undefined,
): string | null {
  for (const candidate of [trimmed(record?.displayName), trimmed(signIn?.displayName)]) {
    if (candidate !== '' && !looksLikeEmail(candidate)) return candidate;
  }
  return null;
}

/**
 * #1857: the name to store with an assignment, for one staff uid whose record
 * is already in hand. The sign-in account is read only when the record has no
 * usable name; a failed read costs only that fallback.
 */
export async function staffNameFor(
  uid: string,
  record: StaffRecord | undefined,
  context: string,
): Promise<string | null> {
  const own = staffNameOnly(record, undefined);
  if (own !== null || uid === '') return own;
  const signIn = await signInIdentities([uid], context);
  return staffNameOnly(record, signIn.get(uid));
}

/**
 * Every uid's identity, in the order given. One `getAll` for the staff records,
 * and an Auth read only for the uids whose record has no name.
 */
export async function resolveStaffIdentities(
  uids: readonly string[],
  context: string,
): Promise<StaffIdentity[]> {
  if (uids.length === 0) return [];
  const firestore = db();
  const snaps = await firestore.getAll(...uids.map((uid) => firestore.collection('staff').doc(uid)));
  const records = snaps.map((snap) => (snap.exists ? (snap.data() as StaffRecord) : undefined));
  return withSignInFallback(uids, records, context);
}

/**
 * The fallback half of [resolveStaffIdentities], for a caller that already has
 * the staff records in hand (`listStaff` reads the whole collection).
 */
export async function withSignInFallback(
  uids: readonly string[],
  records: ReadonlyArray<StaffRecord | undefined>,
  context: string,
): Promise<StaffIdentity[]> {
  const gaps = uids.filter((_uid, i) => !trimmed(records[i]?.displayName));
  const signIn = gaps.length > 0 ? await signInIdentities(gaps, context) : new Map();
  return uids.map((uid, i) => mergeIdentity(uid, records[i], signIn.get(uid)));
}

/**
 * #1870: a visit assigned to someone, with no name stored beside the uid.
 *
 * Until #1857 the assignment writers stored only the staff record's name, and
 * the owner's record had none, so every visit she was given carried
 * `auntieDisplayName: null`. The office's drawer read "Assigned" and MyTribe
 * read "Not yet assigned" for the same booking. The writers now store a name,
 * and this fills one in at read time for the visits written before that.
 *
 * Name only (record name, then sign-in display name), never an email: a
 * household reads this.
 */
export function needsAssigneeName(data: Record<string, unknown>): string | null {
  const uid = data['assignedAuntieUid'];
  const name = data['auntieDisplayName'];
  if (typeof uid !== 'string' || uid === '') return null;
  if (typeof name === 'string' && name.trim() !== '' && !looksLikeEmail(name)) return null;
  return uid;
}

/**
 * uid -> name for every uid given, read in one `getAll` plus one sign-in lookup
 * for the records with no name. A uid with no name anywhere is left out. Never
 * throws: a failed read leaves the visit as it was stored.
 */
export async function assigneeNamesFor(
  uids: readonly string[],
  context: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(uids.filter((u) => u !== ''))];
  if (unique.length === 0) return out;
  try {
    const firestore = db();
    const snaps = await firestore.getAll(...unique.map((uid) => firestore.collection('staff').doc(uid)));
    const records = snaps.map((s) => (s.exists ? (s.data() as { displayName?: unknown }) : undefined));
    const gaps = unique.filter((_uid, i) => staffNameOnly(records[i], undefined) === null);
    const signIn = gaps.length > 0 ? await signInIdentities(gaps, context) : new Map();
    unique.forEach((uid, i) => {
      const name = staffNameOnly(records[i], signIn.get(uid));
      if (name !== null) out.set(uid, name);
    });
  } catch {
    /* best effort: the stored record stands */
  }
  return out;
}

/** The visit's fields with its assignee's name filled in, when it was missing and is now known. */
export function withAssigneeName(
  data: Record<string, unknown>,
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const uid = needsAssigneeName(data);
  if (uid === null) return data;
  const name = names.get(uid);
  if (name !== undefined) return { ...data, auntieDisplayName: name };
  // An email stored in the name's place is never handed on.
  const stored = data['auntieDisplayName'];
  return typeof stored === 'string' && looksLikeEmail(stored) ? { ...data, auntieDisplayName: null } : data;
}
