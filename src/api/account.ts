import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';

/**
 * The signed-in operator's personal profile, stored at `users/{uid}` (rules:
 * `allow read, write: if isAuntie()`). Ports the wasm's `UserProfile`
 * (FirestoreClient.kt), but only the fields this READ-ONLY Account overview
 * renders. The wasm Account screen is an editor (profile + security + a link to
 * notification settings); create/edit/save is deferred, so `onOpenNotifications`
 * is this screen's only outbound hook.
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
 * Field-by-field merge over the shipped empty profile. Defensive: a `users/{uid}`
 * doc missing any field (or a legacy doc predating a field) never throws and
 * never renders `undefined`; every string field is defaulted. Never fabricates a
 * value, only fills blanks.
 */
export function mergeUserProfile(raw: Partial<UserProfile> | undefined | null): UserProfile {
  const r = raw ?? {};
  return {
    uid: r.uid ?? EMPTY_PROFILE.uid,
    email: r.email ?? EMPTY_PROFILE.email,
    displayName: r.displayName ?? EMPTY_PROFILE.displayName,
    firstName: r.firstName ?? EMPTY_PROFILE.firstName,
    lastName: r.lastName ?? EMPTY_PROFILE.lastName,
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
