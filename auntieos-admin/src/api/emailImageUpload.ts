import {
  BUSINESS_ENTITY_ID,
  requestSignedUpload,
  uploadToCloudinary,
  writeMediaFileDoc,
  type UploadStage,
} from './mediaUpload';

/**
 * #953: images for email templates. The same sign, upload, record pipeline as
 * the gallery (`mediaUpload.ts`), filed under the business so the image also
 * shows in Gallery. `uploadMediaFile` returns the gallery doc id, and an email
 * needs the delivery URL, so the three steps are composed here instead.
 *
 * 5 MB, not Cloudinary's limit: an email is read on phones over mobile data,
 * and a photo larger than this is almost always a camera original nobody
 * meant to send.
 */
export const EMAIL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const EMAIL_IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/i;

export function emailImageFileError(file: { type: string; size: number }): string | null {
  if (!EMAIL_IMAGE_TYPES.test(file.type)) return 'Pick a JPG, PNG, GIF or WebP image.';
  if (file.size > EMAIL_IMAGE_MAX_BYTES) {
    return `That image is ${(file.size / (1024 * 1024)).toFixed(1)} MB. Pick one under 5 MB.`;
  }
  return null;
}

export async function uploadEmailImage(file: File, onStage?: (stage: UploadStage) => void): Promise<string> {
  const problem = emailImageFileError(file);
  if (problem) throw new Error(problem);
  onStage?.('signing');
  const sign = await requestSignedUpload('BUSINESS', BUSINESS_ENTITY_ID, 'image');
  onStage?.('uploading');
  const cloud = await uploadToCloudinary(file, sign);
  // Ruling C10: the server keeps only
  // `https://res.cloudinary.com/<CLOUDINARY_CLOUD_NAME>/image/upload/` on
  // save, and this client has no way to read that secret. What it DOES know
  // is the cloud name the signer itself just returned -- the signer and the
  // functions secret name the same cloud -- so checking the upload result
  // against `sign.cloudName` (not a cloud-agnostic pattern) catches a
  // raw/video misclassification before it's ever inserted into the editor,
  // rather than silently losing it on save the way `saveTemplate` does.
  const deliveryPrefix = `https://res.cloudinary.com/${sign.cloudName}/image/upload/`;
  if (!cloud.secureUrl.startsWith(deliveryPrefix)) {
    throw new Error('Cloudinary did not store this file as an image. Pick a JPG, PNG, GIF or WebP image.');
  }
  onStage?.('saving');
  await writeMediaFileDoc({
    entityId: BUSINESS_ENTITY_ID,
    entityType: 'BUSINESS',
    originalFileName: file.name,
    cloud,
    cloudName: sign.cloudName,
  });
  return cloud.secureUrl;
}
