import { addDoc, collection } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';

/**
 * Media UPLOAD, the write-side counterpart to `api/gallery.ts` (list/read
 * only) and `api/media.ts`. Ported from the proven three-client pipeline
 * (`web/composeApp/.../data/JvmMediaUpload.kt`, the wasm's
 * `fetchSignedUpload`/`pickAndUploadKinTaleMedia` in `FirestoreInterop.wasmJs.kt`
 * + `firebase-bridge.js`, and Android's `MediaUploadManager`): sign -> upload
 * to Cloudinary -> write a `media_files` doc, client-side, direct. No
 * "confirm upload" Cloud Function exists for general gallery media (unlike
 * KinPhoto's signed-URL flow); this is the same direct-write shape
 * `api/kinTalesWrite.ts` already uses for `kin_care_reports`.
 *
 * THIS IS AN `onRequest` HTTP endpoint, not an `onCall` callable, so it goes
 * through `fetch`, never `lib/fns.ts#call`:
 *
 *   1. SIGN     POST /api/cloudinary/sign-upload (same-origin, hosting
 *               rewrite -> `signCloudinaryUpload`), `Authorization: Bearer
 *               <idToken>`, JSON body `{ folder, entityType, entityId }`.
 *               The SERVER owns the canonical folder: the response's
 *               `folder` is what actually gets used below, never the
 *               request's guess (mirrors every existing client).
 *   2. UPLOAD   POST https://api.cloudinary.com/v1_1/{cloudName}/auto/upload,
 *               multipart/form-data: file, api_key, timestamp, signature,
 *               folder. Exactly the field set JvmMediaUpload.kt and the
 *               wasm's `pickAndUploadKinTaleMedia` send today, no more (in
 *               particular, no `allowed_formats` field, even though the
 *               signer's response carries one: every shipped client omits
 *               it, so this mirrors the real, already-working pipeline
 *               rather than the field list alone).
 *   3. WRITE    `addDoc` directly to `media_files`, no Cloud Function
 *               involved, same field shape `JvmMediaUpload.kt#upload`'s
 *               `MediaFile` record writes.
 */

// ── entity target ────────────────────────────────────────────────────────────

/**
 * The three targets this dialog supports, mirroring Android/wasm's
 * `MediaEntityType` enum names (KINFOLK/KIN/BUSINESS) verbatim, the same
 * SCREAMING_SNAKE convention `MediaFile.fileType` already uses (IMAGE/VIDEO).
 * The full Kotlin enum has more members (HOUSEHOLD/VISIT_LOG/INVOICE/
 * TRAINING/TRIBAL_INTEL/USER); only the three a general Gallery upload
 * dialog can target are modeled here.
 */
export type UploadEntityType = 'KINFOLK' | 'KIN' | 'BUSINESS';

/**
 * The fixed entityId Android's `AdminSettingsViewModel#uploadLogo` uses for
 * the BUSINESS target (`entityId = "business_settings"`): there is no
 * per-business roster to pick from, so this is a constant, not a picker.
 */
export const BUSINESS_ENTITY_ID = 'business_settings';

// ── 1. sign ──────────────────────────────────────────────────────────────────

const SIGN_ENDPOINT = '/api/cloudinary/sign-upload';

export interface CloudinarySignedUpload {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  /** SERVER-computed canonical folder; always what the Cloudinary upload uses, never the request's guess. */
  folder: string;
  allowedFormats: string;
  entityType: string;
  entityId: string;
}

/** Reads `{ message }` or `{ error }` off a JSON error body, falling back to the raw HTTP status, never a blank error. */
async function readErrorMessage(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `HTTP ${resp.status}`;
  } catch {
    return `HTTP ${resp.status}`;
  }
}

/**
 * Requests a signed-upload grant for one entity target. Fail-loud at every
 * step: no signed-in admin, a non-200 response, or a response missing a
 * required field all throw with a specific, actionable message, never a
 * silently-empty signature that would just fail later at Cloudinary with a
 * more confusing error.
 */
export async function requestSignedUpload(
  entityType: UploadEntityType,
  entityId: string,
): Promise<CloudinarySignedUpload> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in. Sign in as an admin, then try the upload again.');

  const token = await user.getIdToken();
  const folder = `tribetails/${entityType.toLowerCase()}/${entityId}`;

  const resp = await fetch(SIGN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ folder, entityType, entityId }),
  });

  if (!resp.ok) {
    const message = await readErrorMessage(resp);
    throw new Error(`Upload signing failed (HTTP ${resp.status}): ${message}`);
  }

  const body = (await resp.json()) as Partial<CloudinarySignedUpload>;
  if (!body.cloudName || !body.apiKey || !body.signature || !body.folder) {
    throw new Error('Upload signer returned an incomplete response (missing cloudName/apiKey/signature/folder).');
  }

  return {
    cloudName: body.cloudName,
    apiKey: body.apiKey,
    timestamp: body.timestamp ?? 0,
    signature: body.signature,
    folder: body.folder,
    allowedFormats: body.allowedFormats ?? '',
    entityType: body.entityType ?? entityType,
    entityId: body.entityId ?? entityId,
  };
}

// ── 2. upload to Cloudinary ──────────────────────────────────────────────────

export interface CloudinaryUploadResult {
  secureUrl: string;
  publicId: string;
  /** "image" | "video" | "raw", straight off Cloudinary's response. */
  resourceType: string;
  format: string;
  bytes: number;
  width?: number;
  height?: number;
  /** Video only. */
  durationSeconds?: number;
}

/**
 * Multipart upload to Cloudinary's `auto/upload` endpoint. Field set mirrors
 * `JvmMediaUpload.kt`/`firebase-bridge.js#pickAndUploadKinTaleMedia` exactly:
 * file, api_key, timestamp, signature, folder. `auto` lets Cloudinary itself
 * pick image vs video (read back via `resource_type`), matching every
 * existing client rather than forcing an `image/upload` endpoint that would
 * reject video.
 */
export async function uploadToCloudinary(
  file: File,
  sign: CloudinarySignedUpload,
): Promise<CloudinaryUploadResult> {
  const form = new FormData();
  form.append('file', file);
  form.append('api_key', sign.apiKey);
  form.append('timestamp', String(sign.timestamp));
  form.append('signature', sign.signature);
  form.append('folder', sign.folder);

  const resp = await fetch(`https://api.cloudinary.com/v1_1/${sign.cloudName}/auto/upload`, {
    method: 'POST',
    body: form,
  });

  const body = (await resp.json().catch(() => null)) as
    | { error?: { message?: string }; secure_url?: string; public_id?: string; resource_type?: string; format?: string; bytes?: number; width?: number; height?: number; duration?: number }
    | null;

  if (!resp.ok) {
    const message = body?.error?.message ?? `Cloudinary upload failed (HTTP ${resp.status})`;
    throw new Error(message);
  }
  if (!body || typeof body.secure_url !== 'string' || body.secure_url === '') {
    throw new Error('Cloudinary returned no secure_url for the uploaded file.');
  }

  return {
    secureUrl: body.secure_url,
    publicId: body.public_id ?? '',
    resourceType: body.resource_type ?? '',
    format: body.format ?? '',
    bytes: typeof body.bytes === 'number' ? body.bytes : 0,
    // Spread rather than assign `undefined` directly: exactOptionalPropertyTypes
    // treats "key present with value undefined" as distinct from "key absent",
    // and these are genuinely ABSENT (no width/height on a document, no
    // duration on a photo), not merely unset.
    ...(typeof body.width === 'number' ? { width: body.width } : {}),
    ...(typeof body.height === 'number' ? { height: body.height } : {}),
    ...(typeof body.duration === 'number' ? { durationSeconds: body.duration } : {}),
  };
}

// ── thumbnail URL ─────────────────────────────────────────────────────────

/**
 * Ports `KinTaleMediaConfig.thumbnailUrl` exactly, but parameterized on the
 * signer's own `cloudName` rather than a hardcoded constant: `w_300,h_300,
 * c_fill,q_auto,f_auto` (+ `so_2.0`, a 2-second-in video still frame, for
 * video), matching the delivered gallery thumbnail size.
 */
export function cloudinaryThumbnailUrl(cloudName: string, publicId: string, isVideo: boolean): string {
  const resource = isVideo ? 'video' : 'image';
  const videoParams = isVideo ? ',so_2.0' : '';
  const ext = isVideo ? '.jpg' : '';
  return `https://res.cloudinary.com/${cloudName}/${resource}/upload/w_300,h_300,c_fill,q_auto,f_auto${videoParams}/${publicId}${ext}`;
}

// ── 3. write the media_files doc ─────────────────────────────────────────────

export interface WriteMediaFileInput {
  entityId: string;
  entityType: UploadEntityType;
  originalFileName: string;
  cloud: CloudinaryUploadResult;
  cloudName: string;
}

/**
 * Direct client-side `addDoc` to `media_files`, mirroring
 * `JvmMediaUpload.kt#upload`'s `MediaFile` record field-for-field:
 *   entityId, entityType, kinfolkId (stamped from entityId ONLY when
 *   entityType is KINFOLK, so the gallery scopes kin-tagging to the owning
 *   household, same parity comment as the JVM source), fileType
 *   (IMAGE/VIDEO from Cloudinary's own `resource_type`), storageUrl
 *   (`secure_url`), thumbnailUrl, originalFileName, uploadedAt (client ISO
 *   instant, matching every other writer on this collection, never
 *   `serverTimestamp()`), uploadedBy (the real signed-in uid, falling back
 *   to "auntie" only when nobody is signed in, same fallback JVM/Android
 *   use), plus width/height/durationSeconds where Cloudinary reported them.
 *
 * `description`/`isProfilePhoto` are stamped here too (blank/`false`) even
 * though the upload dialog itself doesn't collect them: `api/gallery.ts`'s
 * `MediaFile` type declares both as REQUIRED strings/booleans, and
 * `lib/mediaFormat.ts#mediaCaption` calls `.trim()` on `description`
 * unconditionally, so a doc missing either field would throw the moment the
 * Gallery grid tried to render it, not degrade gracefully.
 */
export async function writeMediaFileDoc(input: WriteMediaFileInput): Promise<string> {
  const isVideo = input.cloud.resourceType.trim().toLowerCase() === 'video';
  const kinfolkId = input.entityType === 'KINFOLK' ? input.entityId : '';
  const uploadedBy = auth.currentUser?.uid?.trim() || 'auntie';

  const fields: Record<string, unknown> = {
    entityId: input.entityId,
    entityType: input.entityType,
    kinfolkId,
    fileType: isVideo ? 'VIDEO' : 'IMAGE',
    storageUrl: input.cloud.secureUrl,
    thumbnailUrl: cloudinaryThumbnailUrl(input.cloudName, input.cloud.publicId, isVideo),
    originalFileName: input.originalFileName,
    uploadedAt: new Date().toISOString(),
    uploadedBy,
    description: '',
    isProfilePhoto: false,
    durationSeconds: input.cloud.durationSeconds ?? 0,
  };
  if (typeof input.cloud.width === 'number') fields.width = input.cloud.width;
  if (typeof input.cloud.height === 'number') fields.height = input.cloud.height;

  const ref = await addDoc(collection(db, 'media_files'), fields);
  return ref.id;
}

// ── orchestrator ──────────────────────────────────────────────────────────

export type UploadStage = 'signing' | 'uploading' | 'saving';

export interface UploadMediaInput {
  file: File;
  entityType: UploadEntityType;
  entityId: string;
  /** Fires once per stage transition, in order, so the dialog can show real progress rather than a fabricated percentage. */
  onStage?: (stage: UploadStage) => void;
}

/**
 * Runs the full sign -> upload -> write pipeline for one file. Fail-loud at
 * every stage: an error thrown by any step propagates as-is (the dialog
 * names the failing step via `onStage`'s last value), never swallowed or
 * downgraded to a silent no-op.
 */
export async function uploadMediaFile(input: UploadMediaInput): Promise<string> {
  const entityId = input.entityId.trim();
  if (entityId === '') throw new Error('uploadMediaFile requires a non-blank entityId');

  input.onStage?.('signing');
  const sign = await requestSignedUpload(input.entityType, entityId);

  input.onStage?.('uploading');
  const cloud = await uploadToCloudinary(input.file, sign);

  input.onStage?.('saving');
  return writeMediaFileDoc({
    entityId,
    entityType: input.entityType,
    originalFileName: input.file.name,
    cloud,
    cloudName: sign.cloudName,
  });
}
