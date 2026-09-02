import { doc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';

/**
 * The write half of api/account.ts, kept in its own module so the read screen's
 * additive extension (this file) does not require touching the committed
 * getUserProfile / UserProfile / mergeUserProfile.
 *
 * The fields the profile editor can change. A strict subset of UserProfile:
 * `uid` is the doc key (never patched), `email` belongs to Firebase Auth, and
 * `photoUrl` is written by `saveUserPhotoUrl` below on behalf of the Account
 * screen's photo control (api/accountPhoto.ts), so none of the three are here.
 */
export interface UserProfilePatch {
  displayName: string;
  firstName: string;
  lastName: string;
  phone: string;
  title: string;
  bio: string;
}

/**
 * Saves the signed-in operator's own `users/{uid}` profile fields.
 *
 * No `saveUserProfile` (or similarly named) callable exists in
 * MyTribe/functions/src, verified with a full grep of that tree; the only
 * near-miss is `portal/saveTribeProfile.ts`, which is the unrelated kinfolk-side
 * tribe profile. The wasm editor writes this doc directly from the client:
 * `SettingsScreen.kt` builds the updated `UserProfile` and calls
 * `FirestoreClient.saveUserProfile`, which reaches
 * `FirestoreInterop.wasmJs.kt#platformSaveUserProfile` -> a raw `setDoc` keyed
 * by uid. `firestore.rules` gates `users/{uid}` with
 * `allow read, write: if isAuntie();`, role-scoped (any admin), not
 * uid-scoped, so this mirrors the wasm's actual access rather than inventing a
 * narrower or wider hole.
 *
 * One deliberate departure from the wasm's write: the wasm's `setDoc` is a full
 * document overwrite, safe there only because its `UserProfile` model carries
 * every field on the doc (theme, nav, dashboard widgets, timestamps, ...) and
 * the screen always spreads the just-loaded profile first. This app's
 * `UserProfile` (api/account.ts) is deliberately a narrower subset built for a
 * read-only overview, so a plain overwrite here would silently erase every
 * field this app doesn't model. `{ merge: true }` writes only the six patch
 * fields plus `updatedAt`, leaving everything else on the document untouched,
 * the same non-destructive intent api/account.ts's field-by-field
 * `mergeUserProfile` already applies on read.
 */
export async function saveUserProfile(uid: string, patch: UserProfilePatch): Promise<void> {
  const id = uid.trim();
  if (id === '') throw new Error('saveUserProfile requires a uid');
  await setDoc(
    doc(db, 'users', id),
    { ...patch, updatedAt: new Date().toISOString() },
    { merge: true },
  );
}

/**
 * Saves the operator's own profile photo URL, and nothing else.
 *
 * Deliberately NOT a field on `UserProfilePatch`: the edit dialog never carries
 * `photoUrl`, so a dialog save can never clear a photo the operator uploaded a
 * moment earlier. Same merge write as `saveUserProfile`, same doc, same rules.
 * The value is whatever `media_files.storageUrl` holds for the upload (see
 * `api/accountPhoto.ts`): Cloudinary's `secure_url`. Android writes its
 * transformed delivery URL to the same field; both are plain image URLs and
 * either client renders either.
 */
export async function saveUserPhotoUrl(uid: string, url: string): Promise<void> {
  const id = uid.trim();
  if (id === '') throw new Error('saveUserPhotoUrl requires a uid');
  const photoUrl = url.trim();
  if (photoUrl === '') throw new Error('saveUserPhotoUrl requires a url');
  await setDoc(
    doc(db, 'users', id),
    { photoUrl, updatedAt: new Date().toISOString() },
    { merge: true },
  );
}
