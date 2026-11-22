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
 * The name is, in order: the staff record's name, the name the person saved on
 * their Account page (`users/{uid}`: display name, then first and last), then
 * the Firebase Auth account's display name. Null when none of those holds a
 * name.
 *
 * NEVER AN EMAIL (#1882). #1564 fell back to the sign-in email, and the
 * 2026-11-10 walk then read an address under "By name:", on the Gallery
 * uploader line and on a kinfolk-facing note. The owner's Account page saves
 * to `users/{uid}`, which this never read, so his saved name never reached
 * those screens. A value shaped like an address is not a name wherever it is
 * stored. `email` stays the staff record's own value.
 *
 * The record is never written here.
 */

export interface StaffIdentity {
  uid: string;
  /** The name to show. Null when no source has a name. Never an email. */
  displayName: string | null;
  /** The staff record's email, as stored. Null when it has none. */
  email: string | null;
  /** False when no `staff/{uid}` document exists. */
  hasStaffRecord: boolean;
}

type StaffRecord = { displayName?: unknown; email?: unknown };
/** The Account page's own profile, `users/{uid}`. */
type ProfileRecord = { displayName?: unknown; firstName?: unknown; lastName?: unknown };

/** `getUsers` takes at most 100 identifiers per call. */
const AUTH_BATCH = 100;

function trimmed(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** A trimmed name, or '' when it is blank or shaped like an email address. */
function nameOnly(v: unknown): string {
  const s = trimmed(v);
  return s.includes('@') ? '' : s;
}

/** The name a profile holds: its display name, else first and last. */
function profileName(profile: ProfileRecord | undefined): string {
  const display = nameOnly(profile?.displayName);
  if (display !== '') return display;
  return nameOnly([trimmed(profile?.firstName), trimmed(profile?.lastName)].filter((s) => s !== '').join(' '));
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
  profile?: ProfileRecord,
): StaffIdentity {
  const recordEmail = trimmed(record?.email);
  const name = nameOnly(record?.displayName) || profileName(profile) || nameOnly(signIn?.displayName);
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
  const gaps = uids.filter((_uid, i) => !nameOnly(records[i]?.displayName));
  const profiles = gaps.length > 0 ? await accountProfiles(gaps, context) : new Map<string, ProfileRecord>();
  const stillGaps = gaps.filter((uid) => !profileName(profiles.get(uid)));
  const signIn = stillGaps.length > 0 ? await signInIdentities(stillGaps, context) : new Map();
  return uids.map((uid, i) => mergeIdentity(uid, records[i], signIn.get(uid), profiles.get(uid)));
}

/**
 * The Account page's profile for each uid (`users/{uid}`), or an empty map
 * when it cannot be read. Like the sign-in lookup, a failure is logged and
 * costs only that rung of the fallback.
 */
async function accountProfiles(uids: readonly string[], context: string): Promise<Map<string, ProfileRecord>> {
  const out = new Map<string, ProfileRecord>();
  const unique = [...new Set(uids.filter((u) => u.length > 0))];
  if (unique.length === 0) return out;
  try {
    const firestore = db();
    const snaps = await firestore.getAll(...unique.map((uid) => firestore.collection('users').doc(uid)));
    snaps.forEach((snap, i) => {
      if (snap.exists) out.set(unique[i]!, snap.data() as ProfileRecord);
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'staffIdentity',
      event: 'staffIdentity.profileLookupFailed',
      errorMessage: err instanceof Error ? err.message : String(err),
      extra: { context, count: unique.length },
    });
  }
  return out;
}
