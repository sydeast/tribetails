import { collection } from 'firebase/firestore';
import { addDoc } from '../lib/firestoreWrite';
import { auth, db } from '../lib/firebase';
import { adminApiFetch, NotSignedInError } from '../lib/adminApiFetch';

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
 *               <idToken>`, JSON body `{ folder, entityType, entityId,
 *               resourceKind }`. The SERVER owns the canonical folder: the
 *               response's `folder` is what actually gets used below, never
 *               the request's guess (mirrors every existing client).
 *   2. UPLOAD   POST https://api.cloudinary.com/v1_1/{cloudName}/auto/upload,
 *               multipart/form-data: file, api_key, timestamp, signature,
 *               folder, plus `transformation` when the signer signed one.
 *               No `allowed_formats` field, even though the signer's
 *               response type carries one: every shipped client omits it, so
 *               this mirrors the real, already-working pipeline rather than
 *               the field list alone.
 *   3. WRITE    `addDoc` directly to `media_files`, no Cloud Function
 *               involved, same field shape `JvmMediaUpload.kt#upload`'s
 *               `MediaFile` record writes.
 *
 * ── #583: THE STORED ORIGINAL CARRIES NO LOCATION ───────────────────────────
 *
 * A photo taken with the phone's location services on has the coordinates
 * inside the file, in its EXIF block, before this app ever sees it. The bytes
 * go straight from the browser to Cloudinary — nothing of ours can edit them
 * in flight — so the only lever is the signature: Cloudinary recomputes it
 * over the params it receives, which makes a signed param one the client is
 * forced to send and an unsigned one it cannot add.
 *
 * So the signer signs `transformation=fl_force_strip` for image uploads and
 * this client posts it verbatim. Cloudinary treats `transformation` as an
 * INCOMING transformation, applied before the asset is stored, so the stored
 * original is the stripped file. `resourceKind` is what tells the signer which
 * kind of upload this is; it is derived from the file's own MIME type by
 * `resourceKindForFile` and is never a caller's free choice.
 */

// ── entity target ────────────────────────────────────────────────────────────

/**
 * The targets this pipeline supports, mirroring Android/wasm's
 * `MediaEntityType` enum names verbatim, the same SCREAMING_SNAKE convention
 * `MediaFile.fileType` already uses (IMAGE/VIDEO).
 *
 * KINFOLK/KIN/BUSINESS are the three the general Gallery upload dialog offers.
 * TRIBAL_INTEL is added for the Tribal Intel attachment flow
 * (`api/tribalIntelWrite.ts#uploadTribalIntelAttachment`), which reuses this
 * exact sign/upload/write pipeline under Android's own entity name so both
 * clients file into the same Cloudinary folder. It is deliberately NOT offered
 * in `MediaUploadDialog`: a general gallery upload has no Tribal Intel entry to
 * attach to.
 *
 * VISIT_LOG is the KinTale composer's photo strip, and its `entityId` is the
 * `kin_care_sessions` DOC ID, not a household or a kin. That is Android's and
 * the desktop's shared convention rather than a choice made here: Android
 * uploads with `entityId = sessionId, entityType = MediaEntityType.VISIT_LOG`
 * (`KinTaleReportViewModel.kt:648`) and the desktop's `KinTaleMediaConfig`
 * files into `tribetails/visit_log/$sessionId` (`MediaModels.kt:49-88`), which
 * is byte-identical to the folder `requestSignedUpload` derives below. So a
 * photo attached to a visit on any platform lands in one Cloudinary folder.
 *
 * The signer needs no change to accept it: `validateUploadFolder`
 * (`auntieos-admin/web/functions/index.js:389`) checks the folder's SHAPE and
 * that its last segment is the entityId, and carries no entity-type allowlist.
 *
 * The full Kotlin enum has more members still (HOUSEHOLD/INVOICE/TRAINING/
 * USER); those stay unmodeled until something uploads to them.
 */
/**
 * `USER` is the operator's own avatar (`users/{uid}.photoUrl`), added 2026-09-01
 * for the web Account screen. Android has sent it since `MediaEntityType.USER`
 * existed and the signer has no entity whitelist, only folder rules.
 */
export type UploadEntityType = 'KINFOLK' | 'KIN' | 'BUSINESS' | 'TRIBAL_INTEL' | 'VISIT_LOG' | 'USER';

/**
 * The fixed entityId Android's `AdminSettingsViewModel#uploadLogo` uses for
 * the BUSINESS target (`entityId = "business_settings"`): there is no
 * per-business roster to pick from, so this is a constant, not a picker.
 */
export const BUSINESS_ENTITY_ID = 'business_settings';

// ── 1. sign ──────────────────────────────────────────────────────────────────

const SIGN_ENDPOINT = '/api/cloudinary/sign-upload';

/**
 * What kind of asset Cloudinary is about to store, in Cloudinary's own
 * vocabulary. The signer needs it because the strip instruction is an IMAGE
 * transformation: signing it onto a video or a document would make Cloudinary
 * reject the upload outright.
 */
export type UploadResourceKind = 'image' | 'video' | 'raw';

/**
 * The file's own MIME type decides, never the caller. `MediaUploadDialog`
 * already refuses anything that is not `image/*` or `video/*`, so `raw` is
 * reachable only through the Tribal Intel attachment picker.
 */
export function resourceKindForFile(file: { type: string }): UploadResourceKind {
  const mime = file.type.trim().toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'raw';
}

export interface CloudinarySignedUpload {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  /** SERVER-computed canonical folder; always what the Cloudinary upload uses, never the request's guess. */
  folder: string;
  allowedFormats: string;
  /**
   * #583. The incoming transformation the server SIGNED (`fl_force_strip` for
   * an image, blank for video/raw). It is part of the signature base, so
   * `uploadToCloudinary` must post it verbatim when it is non-empty and must
   * not post it at all when it is empty — either mismatch is an "Invalid
   * Signature" from Cloudinary.
   */
  transformation: string;
  /**
   * #593. The tags the server SIGNED (`needs-gps-strip` for a video, blank for
   * image/raw). Same contract as `transformation`: part of the signature base,
   * so post it verbatim when non-empty and not at all when empty.
   *
   * A video's location metadata cannot be stripped inside the upload the way a
   * photo's is, so it is stripped asynchronously afterwards. This tag marks the
   * asset as not-yet-stripped at Cloudinary itself, independently of whether a
   * Firestore row was ever written for it.
   */
  tags: string;
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
  resourceKind: UploadResourceKind = 'image',
): Promise<CloudinarySignedUpload> {
  const folder = `tribetails/${entityType.toLowerCase()}/${entityId}`;

  // Token handling, including the refresh-and-retry when the signer rejects a
  // stale one, lives in adminApiFetch; see its header for the 401 this closes.
  let resp: Response;
  try {
    resp = await adminApiFetch(SIGN_ENDPOINT, 'uploading media', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, entityType, entityId, resourceKind }),
    });
  } catch (err) {
    if (err instanceof NotSignedInError) {
      throw new Error('Not signed in. Sign in as an admin, then try the upload again.');
    }
    throw err;
  }

  if (!resp.ok) {
    const message = await readErrorMessage(resp);
    // A 401 that survived the retry is an account problem, not a hiccup, and
    // "Upload signing failed (HTTP 401): invalid_bearer_token" tells the
    // operator nothing they can act on.
    if (resp.status === 401) {
      throw new Error(
        'Upload signing refused this sign-in, even after refreshing it. Sign out and back in; if it keeps refusing, the account may have been revoked.',
      );
    }
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
    // Defaults to blank so a signer that predates #583 keeps working: no
    // transformation signed, none posted, same request as before.
    transformation: body.transformation ?? '',
    // Same defaulting as `transformation`, for the same reason: a signer that
    // predates #593 signs no tags, so none are posted and the request stays
    // byte-identical to what it was before.
    tags: body.tags ?? '',
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
 * `JvmMediaUpload.kt` and Android's `MediaUploadManager`: file, api_key,
 * timestamp, signature, folder, plus `transformation` when the signer signed
 * one. `auto` lets Cloudinary itself pick image vs video (read back via
 * `resource_type`), matching every existing client rather than forcing an
 * `image/upload` endpoint that would reject video.
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
  // #583. Signed server-side, so it is posted exactly when it was signed and
  // never otherwise: a blank value means the signer signed no transformation.
  if (sign.transformation) form.append('transformation', sign.transformation);
  // #593. Signed server-side on exactly the same terms.
  if (sign.tags) form.append('tags', sign.tags);

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
 *
 * KINFOLKID IS OMITTED, NEVER BLANK, FOR A NON-KINFOLK TARGET. Kinfolk do not
 * "own" media (operator ruling 2026-07-31): KIN/BUSINESS uploads (company
 * media, pet media, anything unrelated to a household) leave `kinfolkId` off
 * the document entirely, the same conditional-field pattern width/height
 * already use below. Stamping `''` instead (the previous behavior) is the
 * exact Firestore trap HANDOFF_2026-07-25 documents for `invoiceId`: equality
 * on `''` silently SKIPS documents that never had the field at all, so a doc
 * explicitly written blank and one that genuinely predates this feature would
 * read as two different things to any future `where('kinfolkId', '==', ...)`.
 * Absent is the one representation every reader (this app's own `str()`
 * coercion, a migration script, a support query) already has to handle
 * anyway, so it is also the only one that never lies.
 */
export async function writeMediaFileDoc(input: WriteMediaFileInput): Promise<string> {
  const isVideo = input.cloud.resourceType.trim().toLowerCase() === 'video';
  const uploadedBy = auth.currentUser?.uid?.trim() || 'auntie';

  const fields: Record<string, unknown> = {
    entityId: input.entityId,
    entityType: input.entityType,
    fileType: isVideo ? 'VIDEO' : 'IMAGE',
    storageUrl: input.cloud.secureUrl,
    thumbnailUrl: cloudinaryThumbnailUrl(input.cloudName, input.cloud.publicId, isVideo),
    originalFileName: input.originalFileName,
    uploadedAt: new Date().toISOString(),
    uploadedBy,
    description: '',
    isProfilePhoto: false,
    durationSeconds: input.cloud.durationSeconds ?? 0,
    // #593. Stamped on every upload, video or not, so the async strip job has
    // the id it needs to address the asset without parsing it back out of a
    // URL. Android and the desktop uploader have always written this field;
    // the web path did not, which left web-uploaded videos addressable only by
    // URL parsing.
    cloudinaryPublicId: input.cloud.publicId,
  };
  // #593. Only a video is queued for the asynchronous location strip. An image
  // was already stripped before Cloudinary stored it (#583), so marking one
  // PENDING would put a permanent false positive in the sweep's queue.
  if (isVideo) {
    fields.gpsStripStatus = 'PENDING';
    fields.gpsStripAttempts = 0;
    fields.gpsStripError = '';
  }
  if (input.entityType === 'KINFOLK') fields.kinfolkId = input.entityId;
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
  // #583: the file's own MIME type picks the resource kind, so an image is
  // always signed with the metadata strip and a video is never signed with an
  // image-only transformation Cloudinary would reject.
  const sign = await requestSignedUpload(input.entityType, entityId, resourceKindForFile(input.file));

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
