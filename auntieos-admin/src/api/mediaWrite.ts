import { doc } from 'firebase/firestore';
import { updateDoc } from '../lib/firestoreWrite';
import { db } from '../lib/firebase';
import { call } from '../lib/fns';

/**
 * The three MUTATING media actions the admin grids need, next to the read
 * layers (`api/gallery.ts`, `api/media.ts`), the upload pipeline
 * (`api/mediaUpload.ts`), and the tagging callable (`api/mediaTags.ts`).
 *
 * Issue #397: S2 (delete a photo, set one as the profile picture) and S3
 * (correct a caption after upload). Android has shipped delete and
 * set-as-profile since before the port; web had neither, and NEITHER platform
 * could fix a caption.
 *
 * WHY THE THREE TAKE DIFFERENT ROUTES — this is the whole design, so it is
 * written down rather than left to be re-derived:
 *
 *   setMediaProfilePhoto   CALLABLE. It is a two-collection write: the flag on
 *                          the chosen `media_files` doc, the flag cleared on its
 *                          siblings, and `kinfolk/kin.profilePictureUrl` (or
 *                          `users.photoUrl`) stamped, all in one atomic batch.
 *                          Already existed and already served Android.
 *
 *   deleteMediaFile        CALLABLE (new, #397 S2). A raw client `deleteDoc`
 *                          would leave the entity's `profilePictureUrl`
 *                          pointing at an asset with no row behind it, and no
 *                          screen in the app could ever clear it again. Same
 *                          two-collection invariant as the set-side, so the same
 *                          answer. See `functions/src/admin/deleteMediaFile.ts`.
 *
 *   updateMediaCaption     DIRECT `updateDoc`. A caption is one free-text field
 *                          on one document with no cross-collection consequence
 *                          at all, and `firestore.rules` already allows an
 *                          `isAuntie()` update on `media_files` for every key
 *                          except `taggedKinIds`. The upload path is itself a
 *                          direct client `addDoc`, so a caption written the same
 *                          way is consistent with how the doc got there.
 *                          Inventing a callable for it would add a cold start
 *                          and a deploy to a field edit that needs neither.
 */

// ── delete ───────────────────────────────────────────────────────────────────

export interface DeleteMediaFileRequest {
  mediaFileId: string;
  /**
   * Optional scope cross-check. The entity-scoped grid (`screens/Media.tsx`)
   * passes the row's OWN `entityId` so a stale id can never delete another
   * household's media; the global Gallery omits it.
   *
   * Pass the value off the ROW, never the route: `#/media/household/fam1`'s
   * type segment is `household` while the stored `entityType` is `KINFOLK`, and
   * the id segment is only equal to `entityId` by convention.
   */
  entityId?: string;
}

export interface DeleteMediaFileResponse {
  ok: true;
  mediaFileId: string;
  entityType: string;
  entityId: string;
  /** True when the owning entity's profile photo pointed at this file and was cleared. */
  clearedProfilePhoto: boolean;
}

/**
 * Destroys one `media_files` doc, clearing the owning entity's profile photo
 * when (and only when) it pointed at this file.
 *
 * The Cloudinary asset itself survives, deliberately — see the callable's
 * header for why. Fail-loud: a refusal (wrong entity, missing doc, lost
 * connection) propagates so the grid can say so, rather than optimistically
 * dropping a tile that is still there.
 */
export async function deleteMediaFile(
  mediaFileId: string,
  entityId?: string,
): Promise<DeleteMediaFileResponse> {
  const id = mediaFileId.trim();
  if (id === '') throw new Error('deleteMediaFile requires a non-blank mediaFileId');
  const scope = entityId?.trim() ?? '';
  return call<DeleteMediaFileRequest, DeleteMediaFileResponse>('deleteMediaFile', {
    mediaFileId: id,
    ...(scope !== '' ? { entityId: scope } : {}),
  });
}

// ── set as profile photo ─────────────────────────────────────────────────────

export interface SetMediaProfilePhotoRequest {
  mediaFileId: string;
  entityType: string;
  entityId: string;
}

export interface SetMediaProfilePhotoResponse {
  ok: true;
  mediaFileId: string;
  entityId: string;
  /** The URL as stamped on the owning entity. */
  photoUrl: string;
}

/**
 * Promotes one file to its entity's profile photo.
 *
 * BOTH `entityType` and `entityId` MUST come off the media ROW. The callable
 * cross-checks them against the stored document and refuses a mismatch, and the
 * route's `{type}` segment (`kin` / `household`) is NOT the stored
 * `entityType` (`KIN` / `KINFOLK`, and lower-case `kinfolk` on older rows).
 * Passing the route segment gets a `failed-precondition`, not a rename.
 */
export async function setMediaProfilePhoto(
  mediaFileId: string,
  entityType: string,
  entityId: string,
): Promise<SetMediaProfilePhotoResponse> {
  const id = mediaFileId.trim();
  const type = entityType.trim();
  const entity = entityId.trim();
  if (id === '') throw new Error('setMediaProfilePhoto requires a non-blank mediaFileId');
  if (type === '' || entity === '') {
    // A row with no entity of its own cannot be anyone's profile photo, and
    // guessing one from the route is exactly the mismatch above.
    throw new Error('This file is not attached to a household or kin, so it cannot be a profile photo.');
  }
  return call<SetMediaProfilePhotoRequest, SetMediaProfilePhotoResponse>('setMediaProfilePhoto', {
    mediaFileId: id,
    entityType: type,
    entityId: entity,
  });
}

// ── caption ──────────────────────────────────────────────────────────────────

/**
 * Caption length cap. Matches nothing on the server because nothing on the
 * server touches this field; it exists so a paste of an entire document cannot
 * become a caption. 500 characters is several sentences, which is more than the
 * grid tile or the viewer will ever show on one line.
 */
export const MAX_CAPTION_LENGTH = 500;

/**
 * Rewrites one file's caption (`media_files.description`).
 *
 * Writes EXACTLY ONE KEY. That is not tidiness: `firestore.rules` refuses any
 * client update whose changed-key set touches `taggedKinIds`, so a write that
 * carried a wider object (a rebuilt row, an `updatedAt` stamp copied from
 * another editor) is one refactor away from being rejected outright — or worse,
 * from clobbering a field this editor never showed. `updateDoc` with a single
 * key also leaves every other field on the document untouched, which a `setDoc`
 * would not.
 *
 * An empty caption is a real, meaningful value: it CLEARS the description, and
 * `mediaCaption` then falls back to the original filename, the same as a file
 * that was never captioned.
 */
export async function updateMediaCaption(mediaFileId: string, caption: string): Promise<void> {
  const id = mediaFileId.trim();
  if (id === '') throw new Error('updateMediaCaption requires a non-blank mediaFileId');
  const description = caption.trim();
  if (description.length > MAX_CAPTION_LENGTH) {
    throw new Error(`A caption can be at most ${MAX_CAPTION_LENGTH} characters.`);
  }
  await updateDoc(doc(db, 'media_files', id), { description });
}

// ── error copy ───────────────────────────────────────────────────────────────

/**
 * Turns whatever a rejected media write threw into one sentence an operator can
 * act on.
 *
 * The callable SDK puts the server's own message on `.message`, and both media
 * callables write theirs as plain-English instructions, so showing it verbatim
 * is the right thing. The fallback covers the non-Error a transport layer can
 * throw: naming the failure beats rendering an empty string, which reads as
 * "nothing went wrong".
 */
export function mediaWriteErrorMessage(err: unknown, action: string): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return `${action} failed for an unknown reason. Try again.`;
}
