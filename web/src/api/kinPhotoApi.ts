import { call } from '../lib/fns';

/**
 * Signed direct-to-Cloudinary kin photo uploads
 * (functions/src/portal/signKinPhotoUpload.ts). Replaces the old
 * base64-through-a-callable `uploadKinPhoto` (deleted — its 2MB cap was the
 * whole point of this feature). No web screen calls this yet: Kin
 * Add/Edit is blocked on O-17 (no mockup exists), same as the rest of that
 * flow — this file exists so the backend is ready the moment that screen
 * gets built. Android already uses the equivalent flow live
 * (KinController.kt's uploadPhoto()).
 */

export interface SignedKinPhotoUpload {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  /** Signed server-side; must be echoed verbatim in the upload POST or
   *  Cloudinary rejects it as a signature mismatch. */
  allowedFormats: string;
}

export function signKinPhotoUpload(kinId: string, kinfolkId?: string): Promise<SignedKinPhotoUpload> {
  const payload: { kinId: string; kinfolkId?: string } = { kinId, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<typeof payload, SignedKinPhotoUpload>('signKinPhotoUpload', payload);
}

export interface ConfirmKinPhotoUploadResult {
  photoUrl: string;
}

export function confirmKinPhotoUpload(
  kinId: string,
  secureUrl: string,
  kinfolkId?: string,
): Promise<ConfirmKinPhotoUploadResult> {
  const payload: { kinId: string; secureUrl: string; kinfolkId?: string } = {
    kinId,
    secureUrl,
    ...(kinfolkId !== undefined ? { kinfolkId } : {}),
  };
  return call<typeof payload, ConfirmKinPhotoUploadResult>('confirmKinPhotoUpload', payload);
}

/**
 * The old base64 path capped this at 2MB because of Firebase callable
 * payload limits, not because 2MB is the right photo size — direct upload
 * has no such constraint, so this sits at Cloudinary's own free-tier
 * per-image ceiling instead. Mirrors KinPhotoPolicy.kt's MAX_BYTES.
 */
export const KIN_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const KIN_PHOTO_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Returns a user-facing problem description, or null when the file is acceptable. */
export function validateKinPhotoFile(file: { size: number; type: string }): string | null {
  if (file.size === 0) return 'That file looks empty. Pick a different photo.';
  if (file.size > KIN_PHOTO_MAX_BYTES) return 'Photos need to be 10MB or smaller.';
  if (!KIN_PHOTO_ALLOWED_MIME_TYPES.includes(file.type.toLowerCase())) return 'Use a JPG, PNG, WebP, or GIF image.';
  return null;
}

/**
 * Direct-to-Cloudinary signed upload — identical recipe to
 * accountApi.ts's uploadAvatarToCloudinary, generalized to any signed
 * folder. Returns the `secure_url`, or null on any failure (non-2xx
 * response, unparsable body, or a body missing secure_url).
 */
export async function uploadKinPhotoToCloudinary(signed: SignedKinPhotoUpload, file: File): Promise<string | null> {
  const form = new FormData();
  form.append('api_key', signed.apiKey);
  form.append('timestamp', String(signed.timestamp));
  form.append('signature', signed.signature);
  form.append('folder', signed.folder);
  if (signed.allowedFormats) form.append('allowed_formats', signed.allowedFormats);
  form.append('file', file, file.name || 'photo');

  const res = await fetch(`https://api.cloudinary.com/v1_1/${signed.cloudName}/image/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { secure_url?: string } | null;
  return body?.secure_url ?? null;
}

/**
 * End-to-end convenience: validate → sign → upload → confirm. Throws with a
 * user-facing message on validation failure or a failed upload/confirm.
 */
export async function uploadKinPhotoSigned(kinId: string, file: File, kinfolkId?: string): Promise<string> {
  const problem = validateKinPhotoFile(file);
  if (problem) throw new Error(problem);

  const signed = await signKinPhotoUpload(kinId, kinfolkId);
  if (!signed.cloudName) throw new Error("Photo uploads aren't available right now. Try again later.");

  const secureUrl = await uploadKinPhotoToCloudinary(signed, file);
  if (!secureUrl) throw new Error('Upload failed, try again.');

  const result = await confirmKinPhotoUpload(kinId, secureUrl, kinfolkId);
  return result.photoUrl;
}
