import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { defineSecret } from 'firebase-functions/params';
import { z } from 'zod';
import { auth } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapHttp } from '../lib/wrapHttp';
import { isStaff } from '../lib/staffGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { signCloudinaryFolderUpload, type CloudinarySignedUpload } from '../lib/cloudinary';

const CLOUDINARY_CLOUD_NAME = defineSecret('CLOUDINARY_CLOUD_NAME');
const CLOUDINARY_API_KEY    = defineSecret('CLOUDINARY_API_KEY');
const CLOUDINARY_API_SECRET = defineSecret('CLOUDINARY_API_SECRET');

/**
 * The AuntieOS admin app's `signCloudinaryUpload` endpoint — hosting-rewritten
 * from `/api/cloudinary/sign-upload` (web/firebase.json) and called directly
 * over HTTP (not `onCall`) by all three shipped clients:
 *   - wasm:    FirestoreInterop.wasmJs.kt `fetchSignedUpload` (ktor, response
 *              decoded straight into the shared `CloudinarySignedUpload` data
 *              class in MediaModels.kt — every field below is REQUIRED there,
 *              no defaults, so omitting one breaks wasm deserialization).
 *   - JVM:     JvmMediaUpload.kt `fetchSignedUpload` (ktor, manual field pull).
 *   - Android: MediaUploadManager.kt `fetchSignedUploadAuth` (OkHttp, manual
 *              field pull; only reads cloudName/apiKey/timestamp/signature/folder).
 *
 * Request:  POST { folder, entityType, entityId } (JSON body),
 *           `Authorization: Bearer <firebase ID token>`.
 * Response: CloudinarySignedUpload { cloudName, apiKey, timestamp, signature,
 *           folder, entityType, entityId }.
 *
 * `folder` in the request is the client's own best-effort guess (and differs
 * across clients — JVM sends `tribetails/entity/{entityId}`, Android sends
 * `tribetails/{entityType}/{entityId}`) but none of the three clients actually
 * use that request value for the real Cloudinary upload: all three build the
 * multipart `folder` field from THIS RESPONSE's `folder` (see `sign.folder` /
 * `uploadAuth.folder` / the `signedUpload.folder` handed to `jsPickAndUpload`).
 * That means the server, not the client, owns the authoritative folder path —
 * so it is rebuilt here from `entityType` + `entityId` (mirrors
 * `signKinPhotoUpload`'s folder-owned-by-server precedent instead of trusting
 * client-supplied path segments), never taken verbatim off the wire.
 *
 * Auth: onRequest gives no `req.auth` (that's an `onCall`-only convenience),
 * so the bearer ID token is verified by hand via `auth().verifyIdToken`, then
 * gated through the same `isStaff` check every other admin endpoint uses
 * (admin custom claim, with the `AUNTIE_OPERATOR_UIDS` env allowlist as the
 * logged transition fallback — RULING O-6).
 */

const ENTITY_TYPE_SCHEMA = z
  .string()
  .trim()
  .min(1, 'entityType is required')
  .max(40)
  .regex(/^[A-Za-z0-9_]+$/, 'entityType must be alphanumeric/underscore');

const ENTITY_ID_SCHEMA = z
  .string()
  .trim()
  .min(1, 'entityId is required')
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, 'entityId must be a plain id');

const SignArgs = z.object({
  entityType: ENTITY_TYPE_SCHEMA,
  entityId: ENTITY_ID_SCHEMA,
  // Accepted for forward-compat / logging only — the response's `folder` is
  // always the server-computed canonical path, never this value verbatim.
  folder: z.string().max(400).optional(),
});

/** Canonical folder layout: `tribetails/{entityType-lowercased}/{entityId}`.
 *  Matches Android's `CloudinaryConfig.getFolderPath` and the wasm/JVM
 *  `KinTaleMediaConfig.folderFor` scheme (`tribetails/visit_log/{sessionId}`
 *  when entityType is `VISIT_LOG`). */
function entityUploadFolder(entityType: string, entityId: string): string {
  return `tribetails/${entityType.toLowerCase()}/${entityId}`;
}

export type SignCloudinaryUploadResponse = CloudinarySignedUpload & {
  entityType: string;
  entityId: string;
};

type MinimalReq = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type MinimalRes = { status: (code: number) => MinimalRes; json: (body: unknown) => void };

function bearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.authorization ?? headers.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = /^Bearer\s+(.+)$/i.exec(value ?? '');
  return match ? match[1] : null;
}

/**
 * Pure handler (req/res shape only) so it can be unit-tested without spinning
 * up an HTTP server — mirrors `getShareLinkHandler`'s extracted-handler shape.
 */
export async function signCloudinaryUploadHandler(req: MinimalReq, res: MinimalRes): Promise<void> {
  initSentry();

  if ((req.method ?? 'POST') !== 'POST') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  const idToken = bearerToken(req.headers);
  if (!idToken) {
    res.status(401).json({ error: 'unauthenticated', message: 'Bearer ID token required.' });
    return;
  }

  let uid: string;
  let hasAdminClaim: boolean;
  try {
    const decoded = await auth().verifyIdToken(idToken);
    uid = decoded.uid;
    hasAdminClaim = decoded.admin === true;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'signCloudinaryUpload',
      event: 'auth.token.invalid',
      errorMessage: (err as Error)?.message,
    });
    res.status(401).json({ error: 'unauthenticated', message: 'Invalid or expired ID token.' });
    return;
  }

  if (!isStaff(uid, hasAdminClaim, 'signCloudinaryUpload')) {
    res.status(403).json({ error: 'permission-denied' });
    return;
  }

  const parsed = SignArgs.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid-argument', message: parsed.error.issues[0]?.message ?? 'Invalid request body.' });
    return;
  }
  const { entityType, entityId } = parsed.data;

  const cloudName = CLOUDINARY_CLOUD_NAME.value();
  const apiKey    = CLOUDINARY_API_KEY.value();
  const apiSecret = CLOUDINARY_API_SECRET.value();
  if (!cloudName || !apiKey || !apiSecret) {
    res.status(500).json({ error: 'cloudinary_signing_not_configured' });
    return;
  }

  const signed = signCloudinaryFolderUpload({
    cloudName,
    apiKey,
    apiSecret,
    folder: entityUploadFolder(entityType, entityId),
  });

  logEvent({
    severity: 'info',
    function: 'signCloudinaryUpload',
    event: 'admin.media.upload.signed',
    uid,
    extra: { entityType, entityId, folder: signed.folder },
  });

  const response: SignCloudinaryUploadResponse = {
    cloudName: signed.cloudName,
    apiKey: signed.apiKey,
    timestamp: signed.timestamp,
    signature: signed.signature,
    folder: signed.folder,
    allowedFormats: signed.allowedFormats,
    entityType,
    entityId,
  };
  res.status(200).json(response);
}

export const signCloudinaryUpload = onRequest(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: [CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, 'SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapHttp('signCloudinaryUpload', async (req: Request, res: Response) => {
    await signCloudinaryUploadHandler(req as unknown as MinimalReq, res as unknown as MinimalRes);
  }),
);
