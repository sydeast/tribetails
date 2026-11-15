import { auth, db } from './firestoreAdmin';

/**
 * WHO WROTE A KINTALE COMMENT, ONE RULE FOR EVERY READER (#1923).
 *
 * WHY THE FIRST FIX DID NOT HOLD. #1371 named a household member from
 * `families/{id}/members/{uid}.displayName` and took its first word. That field
 * is the login's EMAIL on every account `acceptInvite` and `primaryMemberRecord`
 * write (`lib/householdMember.ts` says so), and an address has no space in it,
 * so the "first name" was the whole address. The test fixtures held a real name
 * there, which is how it passed. Three readers each carried their own copy of
 * that read (the in-app thread, the public share page, the notice trigger), and
 * only the trigger had learned to refuse an address. #1371 also changed only the
 * portal: the admin web, admin Android and desktop console never read the name
 * the server sent, so they kept printing "Kinfolk".
 *
 * THE ORDER, for a comment from the household's side, worked out on every read
 * (nothing is saved on the comment, so a name the person adds later shows on
 * their old comments too):
 *  1. the member's display name: the member record, the person's own account
 *     (`clients/{uid}`), their sign-in profile (what Account and the header
 *     read), or the Secondary Kinfolk record linked to this login;
 *  2. their first name: a `firstName` on those records, or the household
 *     contact's first name when the author is the PRIMARY (or a login from
 *     before member records, which is treated as the primary everywhere);
 *  3. the household's name;
 *  4. "A member of the household".
 *
 * Every level passes {@link nameOrNull}: an email address is never a name and
 * neither is an id. A lookup that fails leaves the author at the last line
 * rather than failing the thread.
 *
 * The resolver returns the FULL name and says whether it names a person or the
 * household, because the readers print it differently: the in-app thread prints
 * a first name, the public share page prints "First L." and must never print a
 * household name (#1407), and the notice trigger wants '' when nobody is named.
 */

/** Printed when nothing names the author. */
export const HOUSEHOLD_MEMBER_FALLBACK = 'A member of the household';

/** A Firebase uid or a Firestore auto id: one unbroken run of 20+ letters and digits. */
const ID_SHAPED = /^[A-Za-z0-9_-]{20,}$/;

/**
 * The value as a printable name, or null. Refuses an email address, anything
 * shaped like a stored id, and any of the ids the caller names in `ids` (a
 * household id can be short and numeric, so the shape test alone misses it).
 */
export function nameOrNull(value: unknown, ids: readonly string[] = []): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (name === '' || name.includes('@')) return null;
  if (ID_SHAPED.test(name) && /\d/.test(name)) return null;
  if (ids.some((id) => id !== '' && (name === id || name === `Tribe ${id}`))) return null;
  return name;
}

/** First word of a name. */
export function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/** What the records say about one household author. */
export interface HouseholdAuthor {
  /** The person's own name in full, or null when no record names them. */
  personName: string | null;
  /** The household's name, or null when it has none on file. */
  householdName: string | null;
}

/** The in-app label for a household author, and whether it names the person. */
export interface InAppAuthor {
  /** A first name, else the household's name, else the generic line. Never empty. */
  name: string;
  /** True only when `name` is the person's own name (not the household's, not the generic line). */
  isPerson: boolean;
}

/** The in-app thread: a first name, else the household's name, else the generic line. */
export function inAppAuthorName(author: HouseholdAuthor | undefined): InAppAuthor {
  if (author?.personName) return { name: firstWord(author.personName), isPerson: true };
  return { name: author?.householdName ?? HOUSEHOLD_MEMBER_FALLBACK, isPerson: false };
}

type Snap = { data(): unknown } | undefined;
const fields = (s: Snap): Record<string, unknown> => (s?.data() as Record<string, unknown> | undefined) ?? {};

/** The household-side names for one thread. */
export interface ThreadAuthors {
  /** One entry per uid asked for. */
  byUid: Map<string, HouseholdAuthor>;
  /** The household's own name, for a comment that carries no author uid. */
  householdName: string | null;
}

/**
 * Display names on the sign-in profiles of `uids`, the name Account saves and
 * the header reads. Best-effort: a failed read names nobody.
 */
async function signInProfileNames(uids: readonly string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (uids.length === 0) return out;
  try {
    for (let i = 0; i < uids.length; i += 100) {
      const res = await auth().getUsers(uids.slice(i, i + 100).map((uid) => ({ uid })));
      for (const user of res.users) out.set(user.uid, user.displayName);
    }
  } catch {
    // The Firestore records still stand.
  }
  return out;
}

/**
 * Names for the household-side authors of one thread.
 *
 * One batched read for the member and account records of every distinct author
 * plus the household's two records; one sign-in profile read only for authors
 * those records leave without a display name; one more (the Secondary Kinfolk
 * list) only when a SECONDARY is still unnamed after that. Never throws: on a
 * failed read every author is left unnamed and the household name is null.
 */
export async function resolveHouseholdAuthors(
  kinfolkId: string,
  authorUids: readonly string[],
): Promise<ThreadAuthors> {
  const uids = [...new Set(authorUids.filter((u) => u !== ''))];
  const out: ThreadAuthors = { byUid: new Map(), householdName: null };
  for (const u of uids) out.byUid.set(u, { personName: null, householdName: null });
  if (kinfolkId === '') return out;
  try {
    const firestore = db();
    const snaps = await firestore.getAll(
      ...uids.map((u) => firestore.doc(`families/${kinfolkId}/members/${u}`)),
      ...uids.map((u) => firestore.doc(`clients/${u}`)),
      firestore.doc(`families/${kinfolkId}`),
      firestore.doc(`kinfolk/${kinfolkId}`),
    );
    const family = fields(snaps[uids.length * 2]);
    const contact = fields(snaps[uids.length * 2 + 1]);
    const householdName =
      nameOrNull(family['displayName'], [kinfolkId]) ??
      nameOrNull(`${nameOrNull(contact['firstName']) ?? ''} ${nameOrNull(contact['lastName']) ?? ''}`, [kinfolkId]);
    out.householdName = householdName;

    const records = uids.map((u, i) => ({ uid: u, member: fields(snaps[i]), account: fields(snaps[i + uids.length]) }));
    const recordName = (r: (typeof records)[number]): string | null => {
      const ids = [r.uid, kinfolkId];
      return nameOrNull(r.member['displayName'], ids) ?? nameOrNull(r.account['displayName'], ids);
    };
    const profiles = await signInProfileNames(records.filter((r) => recordName(r) === null).map((r) => r.uid));

    // Level 1: a display name.
    const displayNames = new Map<string, string | null>();
    for (const r of records) displayNames.set(r.uid, recordName(r) ?? nameOrNull(profiles.get(r.uid), [r.uid, kinfolkId]));
    const unnamedSecondaries = records
      .filter((r) => displayNames.get(r.uid) === null && r.member['role'] === 'SECONDARY')
      .map((r) => r.uid);
    if (unnamedSecondaries.length > 0) {
      try {
        const people = await firestore.collection(`families/${kinfolkId}/secondaryKinfolk`).get();
        for (const doc of people.docs) {
          const person = (doc.data() ?? {}) as Record<string, unknown>;
          const memberUid = typeof person['memberUid'] === 'string' ? person['memberUid'] : '';
          if (!unnamedSecondaries.includes(memberUid)) continue;
          const name = nameOrNull(person['name'], [memberUid, kinfolkId]);
          if (name) displayNames.set(memberUid, name);
        }
      } catch {
        // The first-name levels below still apply.
      }
    }
    // Level 2: a first name.
    for (const r of records) {
      const ids = [r.uid, kinfolkId];
      // A login with no member record is the household's primary everywhere
      // else (`hasKinfolkPerm`'s "legacy primary"), so it is here too.
      const isPrimary = r.member['role'] === 'PRIMARY' || Object.keys(r.member).length === 0;
      const personName =
        displayNames.get(r.uid) ??
        nameOrNull(r.member['firstName'], ids) ??
        nameOrNull(r.account['firstName'], ids) ??
        // The household contact IS the primary. Never a secondary: that would
        // sign one person's words with another person's name.
        (isPrimary ? nameOrNull(contact['firstName'], ids) : null);
      out.byUid.set(r.uid, { personName, householdName });
    }
  } catch {
    // Best-effort: whatever was resolved before the failure stands.
  }
  return out;
}
