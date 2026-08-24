/**
 * What the upload dialog will accept, as pure functions so the rules have
 * direct test coverage instead of living inline in a component.
 *
 * THESE ARE ANDROID'S LIMITS, not new ones invented for web (#397 S1). Android
 * has refused an oversized or non-media file since before the web port existed:
 *
 *   size   `CloudinaryConfig.MAX_FILE_SIZE` = 50 * 1024 * 1024, enforced in
 *          `MediaUploadManager.kt` ("Selected media exceeds the 50MB limit").
 *   type   `MediaUploadManager.determineMediaType` recognises exactly
 *          `image/*` and `video/*`; anything else falls through to DOCUMENT,
 *          which the gallery upload path does not offer.
 *
 * Web had NEITHER check. The `accept="image/*,video/*"` attribute on the file
 * input is a file-picker hint and nothing more: it is trivially bypassed with
 * "All files", and drag-and-drop ignores it outright. So a 900MB archive went
 * straight at Cloudinary and failed there, minutes later, with Cloudinary's own
 * wording instead of ours.
 */

/** 50MB, byte-for-byte `CloudinaryConfig.MAX_FILE_SIZE`. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** "50MB" / "1.5MB" — whole numbers stay whole, so the cap reads as the round number it is. */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  const rounded = Math.round(mb * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}MB`;
}

/**
 * The one accepted-type test, mirroring `determineMediaType`'s prefix match.
 *
 * A browser can report a BLANK `type` for a file it does not recognise, and for
 * some drag-and-drop sources. Blank is refused rather than waved through: the
 * whole point of this check is that the server-side signer trusts the client
 * about what it is sending, and "I don't know what this is" is not a photo.
 */
export function isAcceptedUploadType(mimeType: string): boolean {
  const t = mimeType.trim().toLowerCase();
  return t.startsWith('image/') || t.startsWith('video/');
}

/**
 * The single sentence to show for a file that cannot be uploaded, or `null`
 * when it can. One function so the dialog cannot check size and forget type.
 *
 * A ZERO-BYTE file is refused too. Cloudinary rejects it anyway, but only after
 * a sign round-trip and an upload, and its error names neither the file nor the
 * reason — an operator who picked a still-syncing cloud file deserves to be
 * told that here.
 */
export function uploadFileError(file: { name: string; type: string; size: number }): string | null {
  if (!isAcceptedUploadType(file.type)) {
    return `${file.name} is not a photo or a video. Choose an image or video file.`;
  }
  if (file.size <= 0) {
    return `${file.name} is empty. If it is still downloading or syncing, wait for it to finish.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name} is ${formatMegabytes(file.size)}. The limit is ${formatMegabytes(MAX_UPLOAD_BYTES)}.`;
  }
  return null;
}
