import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPerm } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import {
  signCloudinaryFolderUpload,
  assertCloudinaryUrlInFolder,
  type CloudinarySignedUpload,
} from '../lib/cloudinary';

const CLOUDINARY_CLOUD_NAME = defineSecret('CLOUDINARY_CLOUD_NAME');
const CLOUDINARY_API_KEY    = defineSecret('CLOUDINARY_API_KEY');
const CLOUDINARY_API_SECRET = defineSecret('CLOUDINARY_API_SECRET');

const KIN_ID_SCHEMA = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/, 'kinId must be a plain doc id');

const SignArgs = z.object({
  kinfolkId: z.string().optional(),
  kinId: KIN_ID_SCHEMA,
});

/**
 * uploadKinPhoto.ts's local helper, duplicated here (and in addBookingNote.ts /
 * kinTaleEngagement.ts / submitRating.ts) rather than shared — this codebase's
 * established convention for write-path kinfolkId resolution (see
 * resolveKinfolkAccess.ts's own doc comment: writes keep per-callable
 * allowlist semantics, no operator override).
 */
async function resolveKinfolkId(uid: string, requested: string | undefined): Promise<string> {
  const clientSnap = await db().collection('clients').doc(uid).get();
  const allowed: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
  if (allowed.length === 0) throw new HttpsError('failed-precondition', 'No tribes linked.');
  const kinfolkId = requested ?? allowed[0];
  if (!allowed.includes(kinfolkId)) throw new HttpsError('permission-denied', 'No access.');
  return kinfolkId;
}

function kinPhotoFolder(kinfolkId: string, kinId: string): string {
  return `tribetails/kinfolks/${kinfolkId}/kin/${kinId}`;
}

/**
 * Returns Cloudinary signed-upload params scoped to one specific kin's photo
 * folder — replaces uploadKinPhoto's base64-through-the-callable path (2MB
 * cap) with direct-to-Cloudinary upload; the server never touches the bytes.
 * Kin-edit-gated and existence-checked BEFORE signing, so a signature can
 * never be minted for a kin the caller doesn't own or that doesn't exist —
 * confirmKinPhotoUpload re-validates independently before writing.
 */
export async function signKinPhotoUploadHandler(
  req: CallableRequest<unknown>,
): Promise<CloudinarySignedUpload> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = SignArgs.parse(req.data);

  const kinfolkId = await resolveKinfolkId(uid, args.kinfolkId);
  // CRITICAL-4: same gate uploadKinPhoto used — signing a folder a caller
  // can write into is itself the sensitive operation, not just the confirm.
  await requireKinfolkPerm(uid, kinfolkId, 'kin_edit', req.auth?.token?.admin === true, 'signKinPhotoUpload');

  const kinSnap = await db().doc(`families/${kinfolkId}/kin/${args.kinId}`).get();
  if (!kinSnap.exists) throw new HttpsError('not-found', 'Kin not found.');

  const cloudName = CLOUDINARY_CLOUD_NAME.value();
  const apiKey    = CLOUDINARY_API_KEY.value();
  const apiSecret = CLOUDINARY_API_SECRET.value();
  if (!cloudName || !apiKey || !apiSecret) {
    throw new HttpsError('failed-precondition', 'cloudinary_signing_not_configured');
  }

  const result = signCloudinaryFolderUpload({
    cloudName,
    apiKey,
    apiSecret,
    folder: kinPhotoFolder(kinfolkId, args.kinId),
  });

  logEvent({
    severity: 'info',
    function: 'signKinPhotoUpload',
    event: 'portal.kin.photo.signed',
    uid,
    extra: { kinfolkId, kinId: args.kinId },
  });
  return result;
}

export const signKinPhotoUpload = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: [CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, 'SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapCallable('signKinPhotoUpload', signKinPhotoUploadHandler),
);

// ---------------------------------------------------------------------------

const ConfirmArgs = z.object({
  kinfolkId: z.string().optional(),
  kinId: KIN_ID_SCHEMA,
  secureUrl: z.string().url().max(2000),
});

export interface ConfirmKinPhotoUploadResult {
  photoUrl: string;
}

/**
 * Persists the result of a direct-to-Cloudinary upload the client just
 * completed using signKinPhotoUpload's signature. Re-resolves kinfolkId +
 * re-checks kin_edit independently (never trust that a caller who could sign
 * a moment ago still can — permissions can change between the two calls),
 * and — critically — validates secureUrl actually is a Cloudinary asset in
 * the exact folder that was signed, not an arbitrary client-supplied URL.
 */
export async function confirmKinPhotoUploadHandler(
  req: CallableRequest<unknown>,
): Promise<ConfirmKinPhotoUploadResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = ConfirmArgs.parse(req.data);

  const kinfolkId = await resolveKinfolkId(uid, args.kinfolkId);
  await requireKinfolkPerm(uid, kinfolkId, 'kin_edit', req.auth?.token?.admin === true, 'confirmKinPhotoUpload');

  const kinRef = db().doc(`families/${kinfolkId}/kin/${args.kinId}`);
  const kinSnap = await kinRef.get();
  if (!kinSnap.exists) throw new HttpsError('not-found', 'Kin not found.');

  const cloudName = CLOUDINARY_CLOUD_NAME.value();
  if (!cloudName) throw new HttpsError('failed-precondition', 'cloudinary_signing_not_configured');

  try {
    assertCloudinaryUrlInFolder(args.secureUrl, cloudName, kinPhotoFolder(kinfolkId, args.kinId));
  } catch (err) {
    throw new HttpsError('invalid-argument', (err as Error).message);
  }

  await kinRef.set(
    { photoUrl: args.secureUrl, updatedAt: FieldValue.serverTimestamp(), updatedByUid: uid },
    { merge: true },
  );

  logEvent({
    severity: 'info',
    function: 'confirmKinPhotoUpload',
    event: 'portal.kin.photo.confirmed',
    uid,
    extra: { kinfolkId, kinId: args.kinId },
  });
  return { photoUrl: args.secureUrl };
}

export const confirmKinPhotoUpload = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: [CLOUDINARY_CLOUD_NAME, 'SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('confirmKinPhotoUpload', confirmKinPhotoUploadHandler),
);
