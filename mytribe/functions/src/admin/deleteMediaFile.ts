import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Issue #397 S2: "Delete media", the destructive twin of `setMediaProfilePhoto`.
 *
 * WHY A CALLABLE, when `firestore.rules` already lets an admin client delete
 * the row directly (and Android's `AuntieRepository.deleteMediaFile` did
 * exactly that): a bare document delete leaves a DANGLING PROFILE PHOTO URL.
 * `setMediaProfilePhoto` stamps `kinfolk/{id}.profilePictureUrl`,
 * `kin/{id}.profilePictureUrl` or `users/{uid}.photoUrl` with the media doc's
 * own `storageUrl`. Delete only the `media_files` row and the gallery forgets
 * the photo while the profile keeps rendering it, with no row left anywhere in
 * the app that can ever clear that field again. That is a two-collection
 * invariant, so it belongs on the server in one atomic batch, exactly as the
 * set-side already is.
 *
 * WHAT THIS GUARANTEES, precisely:
 *   - the `media_files` doc is deleted;
 *   - the owning entity's photo field is cleared to `''` IF AND ONLY IF it
 *     currently points at this doc's own `storageUrl` or `thumbnailUrl`. An
 *     entity whose photo came from somewhere else is left alone: removing one
 *     gallery row must never blank a profile picture it did not set.
 *   - NO replacement photo is promoted. Picking "the next most recent image"
 *     would invent a choice the operator did not make; a blank URL is what
 *     every client already renders an initials avatar for.
 *
 * Cleared to `''`, not `FieldValue.delete()`: `profilePictureUrl` is a field
 * every reader treats as a string (`.ifBlank`, `.trim()`, `createKin` seeds it
 * `''`) and it is never an equality-query key, so the absent-over-blank rule
 * that governs `kinfolkId` does not apply here. Blank is what "no photo"
 * already means on this field.
 *
 * THE CLOUDINARY ASSET IS NOT DESTROYED, deliberately. The credential this app
 * holds is an upload grant, not a destroy grant (`signCloudinaryUpload` signs
 * uploads only), no client has ever destroyed an asset, and quietly reaching
 * into the operator's media library to erase the original is not a side effect
 * a "remove this from the gallery" button should have. The orphaned asset is a
 * known, deliberate state; the audit entry below records `storageUrl` so it
 * stays reachable after the row is gone.
 *
 * Gated by wrapAdminCallable (admin custom claim); the admin SDK bypasses rules.
 */
const Args = z.object({
  mediaFileId: z.string().min(1).max(120),
  /**
   * Optional cross-check for the entity-SCOPED callers (the web
   * `#/media/{type}/{id}` grid, Android's `MediaGalleryScreen`). When supplied,
   * a doc belonging to a different entity is refused rather than deleted, so a
   * stale row id from one household can never delete another household's media.
   * Omitted by the unscoped caller (the all-business Gallery), where the doc's
   * own entity is the only truth available.
   *
   * `entityType` is deliberately NOT part of the cross-check: live `media_files`
   * rows carry both `"kinfolk"` and `"BUSINESS"` casings (see
   * `auntieos-admin/src/api/media.ts`'s header), so comparing it would refuse
   * legitimate deletes on a casing accident. `entityId` is a Firestore document
   * id, unique and unambiguous, which is all the narrowing this needs.
   */
  entityId: z.string().min(1).max(120).optional(),
});

export interface DeleteMediaFileResult {
  ok: true;
  mediaFileId: string;
  entityType: string;
  entityId: string;
  /** True when the owning entity's photo field pointed at this doc and was cleared. */
  clearedProfilePhoto: boolean;
}

/** `media_files.entityType` -> the owning doc path + the field holding its photo URL. */
function photoTargetFor(
  entityType: string,
  entityId: string,
): { path: string; field: 'profilePictureUrl' | 'photoUrl' } | null {
  const t = entityType.trim().toUpperCase();
  if (entityId.trim() === '') return null;
  if (t === 'KINFOLK') return { path: `kinfolk/${entityId}`, field: 'profilePictureUrl' };
  if (t === 'KIN') return { path: `kin/${entityId}`, field: 'profilePictureUrl' };
  if (t === 'USER') return { path: `users/${entityId}`, field: 'photoUrl' };
  // BUSINESS / TRIBAL_INTEL / anything unmodeled: the media doc goes and no
  // entity doc is invented to write to. The same stance the set-side takes.
  return null;
}

export async function deleteMediaFileHandler(
  req: CallableRequest<unknown>,
): Promise<DeleteMediaFileResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'deleteMediaFile validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const mediaRef = db().doc(`media_files/${args.mediaFileId}`);
  const snap = await mediaRef.get();
  if (!snap.exists) {
    // Fail loud rather than returning a cheerful ok on a doc that was never
    // there: a silent success hides a wrong id, and the caller's grid would
    // simply keep showing the row it believes it deleted.
    throw new HttpsError('not-found', `Media file '${args.mediaFileId}' not found.`);
  }
  const media = snap.data() as
    | {
        storageUrl?: string;
        thumbnailUrl?: string;
        entityId?: string;
        entityType?: string;
        originalFileName?: string;
      }
    | undefined;

  const docEntityId = (media?.entityId ?? '').trim();
  const docEntityType = (media?.entityType ?? '').trim();

  if (args.entityId !== undefined && docEntityId !== args.entityId.trim()) {
    throw new HttpsError(
      'failed-precondition',
      `Media file '${args.mediaFileId}' belongs to a different entity ` +
        `(doc=${docEntityId || '(none)'}, args=${args.entityId.trim()}).`,
    );
  }

  // Read the owning entity BEFORE the batch: the clear is conditional on what
  // that doc currently holds, and a batch cannot read.
  let clearedProfilePhoto = false;
  const target = photoTargetFor(docEntityType, docEntityId);
  const ownUrls = [media?.storageUrl ?? '', media?.thumbnailUrl ?? '']
    .map((u) => u.trim())
    .filter((u) => u !== '');
  let clearTargetPath: string | null = null;
  let clearTargetField: 'profilePictureUrl' | 'photoUrl' | null = null;
  if (target !== null && ownUrls.length > 0) {
    const entitySnap = await db().doc(target.path).get();
    const entity = entitySnap.exists
      ? (entitySnap.data() as Record<string, unknown> | undefined)
      : undefined;
    const current = typeof entity?.[target.field] === 'string' ? (entity[target.field] as string) : '';
    if (current.trim() !== '' && ownUrls.includes(current.trim())) {
      clearTargetPath = target.path;
      clearTargetField = target.field;
      clearedProfilePhoto = true;
    }
  }

  const batch = db().batch();
  batch.delete(mediaRef);
  if (clearTargetPath !== null && clearTargetField !== null) {
    batch.set(
      db().doc(clearTargetPath),
      { [clearTargetField]: '', updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
  await batch.commit();

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MEDIA_FILE_DELETED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: {
      mediaFileId: args.mediaFileId,
      entityType: docEntityType.toUpperCase(),
      entityId: docEntityId,
      // The URL goes in the trail because the row itself is gone: without it an
      // accidental delete leaves nothing at all to recover the asset from.
      storageUrl: media?.storageUrl ?? '',
      originalFileName: media?.originalFileName ?? '',
      clearedProfilePhoto,
    },
  });

  logEvent({
    severity: 'info',
    function: 'deleteMediaFile',
    event: 'admin.media.deleted',
    uid,
    extra: {
      mediaFileId: args.mediaFileId,
      entityType: docEntityType.toUpperCase(),
      entityId: docEntityId,
      clearedProfilePhoto,
    },
  });

  return {
    ok: true,
    mediaFileId: args.mediaFileId,
    entityType: docEntityType.toUpperCase(),
    entityId: docEntityId,
    clearedProfilePhoto,
  };
}

export const deleteMediaFile = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('deleteMediaFile', deleteMediaFileHandler),
);
