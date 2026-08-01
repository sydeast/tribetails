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
 * Spec 28 item 1 / 29 item 10: server-bound "Set as profile photo" action.
 * Flips isProfilePhoto=true on the chosen media_files doc, clears the flag on
 * sibling docs of the SAME entity, and stamps the owning entity's photo URL
 * field (kinfolk.profilePictureUrl, kin.profilePictureUrl, or users/{uid}.photoUrl)
 * in one atomic batch with an audit entry. The doc's own entityId/entityType are
 * the source of truth so a caller cannot flip a media file onto a foreign entity.
 * Gated by wrapAdminCallable (admin custom claim); admin SDK bypasses rules.
 */
const Args = z.object({
  mediaFileId: z.string().min(1).max(120),
  entityType: z.string().min(1).max(40),
  entityId: z.string().min(1).max(120),
});

export interface SetMediaProfilePhotoResult {
  ok: true;
  mediaFileId: string;
  entityId: string;
  photoUrl: string;
}

export async function setMediaProfilePhotoHandler(
  req: CallableRequest<unknown>,
): Promise<SetMediaProfilePhotoResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'setMediaProfilePhoto validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const chosenRef = db().doc(`media_files/${args.mediaFileId}`);
  const chosenSnap = await chosenRef.get();
  if (!chosenSnap.exists) {
    throw new HttpsError('not-found', `Media file '${args.mediaFileId}' not found.`);
  }
  const chosen = chosenSnap.data() as
    | { storageUrl?: string; entityId?: string; entityType?: string }
    | undefined;

  // The doc's own entity is the source of truth: reject cross-entity flips.
  const docEntityId = chosen?.entityId ?? '';
  const docEntityType = (chosen?.entityType ?? '').toUpperCase();
  const argEntityType = args.entityType.toUpperCase();
  if (docEntityId !== args.entityId || docEntityType !== argEntityType) {
    throw new HttpsError(
      'failed-precondition',
      `Media file '${args.mediaFileId}' belongs to a different entity (` +
        `doc=${docEntityType}/${docEntityId}, args=${argEntityType}/${args.entityId}).`,
    );
  }

  const storageUrl = chosen?.storageUrl ?? '';
  if (!storageUrl) {
    throw new HttpsError('failed-precondition', `Media file '${args.mediaFileId}' has no storageUrl.`);
  }

  const batch = db().batch();

  // Clear isProfilePhoto on existing profile siblings of the same entity.
  const siblings = await db()
    .collection('media_files')
    .where('entityId', '==', args.entityId)
    .where('entityType', '==', chosen?.entityType ?? args.entityType)
    .where('isProfilePhoto', '==', true)
    .get();
  for (const sib of siblings.docs) {
    if (sib.id === args.mediaFileId) continue;
    batch.set(db().doc(`media_files/${sib.id}`), { isProfilePhoto: false }, { merge: true });
  }

  // Mark the chosen doc.
  batch.set(chosenRef, { isProfilePhoto: true }, { merge: true });

  // Stamp the owning entity's photo field in the same atomic batch.
  if (argEntityType === 'KINFOLK') {
    batch.set(
      db().doc(`kinfolk/${args.entityId}`),
      { profilePictureUrl: storageUrl, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  } else if (argEntityType === 'KIN') {
    batch.set(
      db().doc(`kin/${args.entityId}`),
      { profilePictureUrl: storageUrl, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  } else if (argEntityType === 'USER') {
    batch.set(
      db().doc(`users/${args.entityId}`),
      { photoUrl: storageUrl, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
  // Any other entityType: flip the media flag only, no fabricated entity target.

  await batch.commit();

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.PROFILE_UPDATED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: {
      mediaFileId: args.mediaFileId,
      entityType: argEntityType,
      entityId: args.entityId,
      photoUrl: storageUrl,
    },
  });

  logEvent({
    severity: 'info',
    function: 'setMediaProfilePhoto',
    event: 'admin.media.profilePhotoSet',
    uid,
    extra: { mediaFileId: args.mediaFileId, entityType: argEntityType, entityId: args.entityId },
  });

  return { ok: true, mediaFileId: args.mediaFileId, entityId: args.entityId, photoUrl: storageUrl };
}

export const setMediaProfilePhoto = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('setMediaProfilePhoto', setMediaProfilePhotoHandler),
);
