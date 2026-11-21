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
