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
 * Issue #397 S2: server-bound "Delete media" action, the destructive twin of
 * `setMediaProfilePhoto`.
 *
 * WHY THIS EXISTS AT ALL, given every client could already `.delete()` the doc
 * directly (android `AuntieRepository#deleteMediaFile`, the wasm's
 * `platformDeleteMedia`): a raw document delete leaves a DANGLING PHOTO URL.
 * `setMediaProfilePhoto` stamps `kinfolk/{id}.profilePictureUrl`,
 * `kin/{id}.profilePictureUrl` or `users/{uid}.photoUrl` with the media doc's
 * `storageUrl`, and android's `uploadKinPhoto`/`uploadKinfolkPhoto` patch the
 * same field directly. Deleting only the `media_files` row leaves those fields
 * pointing at a Cloudinary asset with no record behind it: the gallery forgets
 * the photo, the profile keeps rendering it, and nothing in the app can ever
 * clear it again. That is a two-collection invariant, so it belongs on the
 * server in one atomic batch, exactly as the set-side already is.
 *
 * WHAT "SANE STATE" MEANS HERE, precisely:
 *   - the `media_files` doc is deleted;
 *   - the owning entity's photo field is cleared to `''` IF AND ONLY IF it
 *     currently points at this doc's own `storageUrl` or `thumbnailUrl`. An
 *     entity whose photo came from somewhere else is left alone: deleting one
 *     gallery row must not blank a profile picture it never set.
 *   - NO replacement photo is promoted. Picking "the next most recent image"
 *     would invent a choice the operator did not make; the profile falls back
 *     to the initials avatar every client already renders for a blank URL.
 *
 * Cleared to `''`, not `FieldValue.delete()`: `profilePictureUrl` is a field
 * every reader treats as a string (`.ifBlank`, `.trim()`, `createKin` seeds it
 * `''`), and it is never an equality-query key, so the absent-over-blank rule
 * that governs `kinfolkId` does not apply. A blank string is what "no photo"
 * already means on this field.
 *
 * The Cloudinary ASSET itself is not destroyed. No client has ever done that
 * (android and wasm both delete the Firestore row only), the signed-upload
 * credential this app holds is an upload grant rather than a destroy grant, and
 * silently reaching for a destroy API on the operator's media library is not a
 * side effect a "remove this from the gallery" button should have. Recorded
 * here so the orphan is a known, deliberate state rather than a surprise.
 *
 * Gated by wrapAdminCallable (admin custom claim); the admin SDK bypasses rules.
 */
const Args = z.object({
  mediaFileId: z.string().min(1).max(120),
  /**
   * Optional cross-check, for the entity-SCOPED callers (`screens/Media.tsx`'s
   * `#/media/{type}/{id}` grid, android's `MediaGalleryScreen`). When supplied,
   * a doc belonging to a different entity is refused rather than deleted, so a
   * stale row id from one household can never delete another's media. Omitted
   * by the unscoped callers (the all-business Gallery), where the doc's own
   * entity is the only truth available.
   */
  entityType: z.string().min(1).max(40).optional(),
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

/** `media_files.entityType` -> the owning doc path + the field that holds its photo URL. */
function photoTargetFor(
  entityType: string,
  entityId: string,
): { path: string; field: 'profilePictureUrl' | 'photoUrl' } | null {
  const t = entityType.trim().toUpperCase();
  if (entityId.trim() === '') return null;
  if (t === 'KINFOLK') return { path: `kinfolk/${entityId}`, field: 'profilePictureUrl' };
  if (t === 'KIN') return { path: `kin/${entityId}`, field: 'profilePictureUrl' };
  if (t === 'USER') return { path: `users/${entityId}`, field: 'photoUrl' };
  // BUSINESS / TRIBAL_INTEL / anything unmodeled: the media doc goes, and no
  // entity doc is invented to write to. Same stance the set-side takes.
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
    // simply keep showing the row it thinks it deleted.
    throw new HttpsError('not-found', `Media file '${args.mediaFileId}' not found.`);
  }
  const media = snap.data() as
    | { storageUrl?: string; thumbnailUrl?: string; entityId?: string; entityType?: string }
    | undefined;

  const docEntityId = (media?.entityId ?? '').trim();
  const docEntityType = (media?.entityType ?? '').trim();

  // The doc's own entity is the source of truth; the args only ever narrow it.
  if (args.entityId !== undefined || args.entityType !== undefined) {
    const argEntityId = (args.entityId ?? '').trim();
    const argEntityType = (args.entityType ?? '').trim().toUpperCase();
    const idMismatch = args.entityId !== undefined && docEntityId !== argEntityId;
    const typeMismatch =
      args.entityType !== undefined && docEntityType.toUpperCase() !== argEntityType;
    if (idMismatch || typeMismatch) {
      throw new HttpsError(
        'failed-precondition',
        `Media file '${args.mediaFileId}' belongs to a different entity (` +
          `doc=${docEntityType.toUpperCase()}/${docEntityId}, args=${argEntityType}/${argEntityId}).`,
      );
    }
  }

  const batch = db().batch();
  batch.delete(mediaRef);

  // Clear the owning entity's photo field ONLY when it points at this very doc.
  let clearedProfilePhoto = false;
  const target = photoTargetFor(docEntityType, docEntityId);
  if (target !== null) {
    const ownUrls = [media?.storageUrl ?? '', media?.thumbnailUrl ?? '']
      .map((u) => u.trim())
      .filter((u) => u !== '');
    if (ownUrls.length > 0) {
      const entitySnap = await db().doc(target.path).get();
      const entity = entitySnap.exists
        ? (entitySnap.data() as Record<string, unknown> | undefined)
        : undefined;
      const current = typeof entity?.[target.field] === 'string' ? (entity[target.field] as string) : '';
      if (current.trim() !== '' && ownUrls.includes(current.trim())) {
        batch.set(
          db().doc(target.path),
          { [target.field]: '', updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        clearedProfilePhoto = true;
      }
    }
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
      // The URL goes into the trail because the row itself is gone: without it
      // an accidental delete leaves nothing at all to recover the asset from.
      storageUrl: media?.storageUrl ?? '',
      originalFileName: (media as { originalFileName?: string } | undefined)?.originalFileName ?? '',
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
