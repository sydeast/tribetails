import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';

/**
 * The signed-in operator's personal profile, stored at `users/{uid}` (rules:
 * `allow read, write: if isAuntie()`). Ports the wasm's `UserProfile`
 * (FirestoreClient.kt). The Account screen reads the profile, edits these
 * fields INLINE, and saves them from its hero "Save profile" button through
 * `api/accountWrite.ts` back to the same `users/{uid}` doc (issue #719 replaced
 * the read-only card plus edit dialog it used to render).
 *
 * A subset of the doc, not a blind mirror: theme/personalization/nav/widget keys
 * live on the real doc but belong to per-operator UI prefs, not this account
 * card, so they are intentionally omitted (the directory.ts convention).
 */
export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
  phone: string;
  title: string;
  photoUrl: string;
  bio: string;
}

const EMPTY_PROFILE: UserProfile = {
  uid: '',
  email: '',
  displayName: '',
  firstName: '',
  lastName: '',
  phone: '',
  title: '',
  photoUrl: '',
  bio: '',
};

/**
 * "Nora Brooks" -> first "Nora", last "Brooks". The split is the LAST
 * whitespace run, so "Ana Maria Brooks" keeps "Ana Maria" as the first name
 * rather than dropping the middle name, and a single word is all first name.
 *
 * Read side only. Nothing writes a joined name: a full grep of this repo (web,
 * `android/`, `mytribe/functions/`) finds no writer and no reader of a
 * `fullName` field on `users/{uid}`, and the split fields are the stored shape
 * on every platform (`Models.kt` `UserProfile`). This exists so a legacy or
 * migrated doc that carried one combined name does not render two blank name
 * boxes on the Account screen (issue #719).
 */
export function splitLegacyFullName(full: string): { firstName: string; lastName: string } {
  const name = (full ?? '').trim().replace(/\s+/g, ' ');
  if (name === '') return { firstName: '', lastName: '' };
  const cut = name.lastIndexOf(' ');
  if (cut === -1) return { firstName: name, lastName: '' };
  return { firstName: name.slice(0, cut), lastName: name.slice(cut + 1) };
}

/** The combined-name keys a legacy or migrated `users/{uid}` doc might carry. */
interface LegacyNameKeys {
  fullName?: unknown;
  name?: unknown;
}

/**
 * Field-by-field merge over the shipped empty profile. Defensive: a `users/{uid}`
 * doc missing any field (or a legacy doc predating a field) never throws and
 * never renders `undefined`; every string field is defaulted. Never fabricates a
 * value, only fills blanks.
 *
 * One derivation: when BOTH split name fields are blank and the doc carries a
 * combined `fullName` (or `name`) string, first/last come from splitting it.
 * The stored doc is never rewritten by a read; the operator's next save writes
 * the two split fields they can see and edit.
 */
export function mergeUserProfile(raw: Partial<UserProfile> | undefined | null): UserProfile {
  const r = raw ?? {};
  const legacy = r as LegacyNameKeys;
  const firstName = r.firstName ?? EMPTY_PROFILE.firstName;
  const lastName = r.lastName ?? EMPTY_PROFILE.lastName;
  // Type-checked, not presence-checked: a doc holding a number under either key
  // must read as "no legacy name", never throw inside `.trim()` (lib/coerce.ts).
  const combined =
    typeof legacy.fullName === 'string'
      ? legacy.fullName
      : typeof legacy.name === 'string'
        ? legacy.name
        : '';
  const split =
    firstName.trim() === '' && lastName.trim() === ''
      ? splitLegacyFullName(combined)
      : { firstName, lastName };
  return {
    uid: r.uid ?? EMPTY_PROFILE.uid,
    email: r.email ?? EMPTY_PROFILE.email,
    displayName: r.displayName ?? EMPTY_PROFILE.displayName,
    firstName: split.firstName,
    lastName: split.lastName,
    phone: r.phone ?? EMPTY_PROFILE.phone,
    title: r.title ?? EMPTY_PROFILE.title,
    photoUrl: r.photoUrl ?? EMPTY_PROFILE.photoUrl,
    bio: r.bio ?? EMPTY_PROFILE.bio,
  };
}

/**
 * One-shot read of `users/{uid}`. Mirrors api/settings.ts's direct getDoc: there
 * is no getUserProfile callable, and useCollection is collection-only, so the
 * single doc is read directly (the same access the wasm's `userProfileStream`
 * uses). A missing doc resolves to the empty profile (a brand-new operator with
 * no profile saved yet), NOT an error; a genuine read rejection propagates so the
 * screen can surface it fail-loud.
 */
export async function getUserProfile(uid: string): Promise<UserProfile> {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) return { ...EMPTY_PROFILE, uid };
  return mergeUserProfile({ ...(snap.data() as Partial<UserProfile>), uid });
}
