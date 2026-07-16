import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { signCloudinaryFolderUpload, type CloudinarySignedUpload } from '../lib/cloudinary';

const CLOUDINARY_CLOUD_NAME = defineSecret('CLOUDINARY_CLOUD_NAME');
const CLOUDINARY_API_KEY    = defineSecret('CLOUDINARY_API_KEY');
const CLOUDINARY_API_SECRET = defineSecret('CLOUDINARY_API_SECRET');

/**
 * Returns Cloudinary signed-upload params scoped to the caller's avatar folder
 * (`tribetails/kinfolks/{uid}/avatars/`). Kinfolk-authed; the signing secret
 * never leaves the server. Mirrors the AuntieOS-side admin signer but with a
 * uid-locked folder so one kinfolk can't write into another's space.
 */
export async function signKinfolkAvatarHandler(
  req: CallableRequest<unknown>,
): Promise<CloudinarySignedUpload> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

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
    folder: `tribetails/kinfolks/${uid}/avatars`,
  });

  logEvent({ severity: 'info', function: 'signKinfolkAvatar', event: 'portal.cloudinary.signed', uid });
  return result;
}

export const signKinfolkAvatar = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: [CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, 'SENTRY_DSN'],
  },
  wrapCallable('signKinfolkAvatar', signKinfolkAvatarHandler),
);
