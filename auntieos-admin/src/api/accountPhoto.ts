import {
  requestSignedUpload,
  uploadToCloudinary,
  writeMediaFileDoc,
  type UploadStage,
} from './mediaUpload';
import { saveUserPhotoUrl } from './accountWrite';
import { MAX_UPLOAD_BYTES, formatMegabytes } from '../lib/mediaUploadLimits';

/**
 * The operator's own profile photo: the same three-step upload every other
 * media surface in this app does (sign, Cloudinary, `media_files` doc), then
 * `users/{uid}.photoUrl`.
 *
 * Ported from Android's `AdminSettingsViewModel.uploadAvatar`, which uploads
 * with `entityType = USER, entityId = uid` and then saves the profile with the
 * new URL. The order is the point: the media doc is written BEFORE the profile
 * points at it, so a profile never references a photo that has no record, and
 * a failure anywhere before the last step leaves `photoUrl` exactly as it was.
 *
 * Images only. `mediaUploadLimits` accepts video too, because the gallery
 * does; an avatar that is a video is a bug the picker should refuse before a
 * byte leaves the machine.
 */
export async function uploadUserPhoto(
  uid: string,
  file: File,
  onStage?: (stage: UploadStage) => void,
): Promise<string> {
  const id = uid.trim();
  if (id === '') throw new Error('uploadUserPhoto requires a uid');
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image file for your photo.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `That file is ${formatMegabytes(file.size)}. The limit is ${formatMegabytes(MAX_UPLOAD_BYTES)}.`,
    );
  }

  onStage?.('signing');
  const sign = await requestSignedUpload('USER', id, 'image');

  onStage?.('uploading');
  const cloud = await uploadToCloudinary(file, sign);

  onStage?.('saving');
  await writeMediaFileDoc({
    entityId: id,
    entityType: 'USER',
    originalFileName: file.name,
    cloud,
    cloudName: sign.cloudName,
  });
  await saveUserPhotoUrl(id, cloud.secureUrl);
  return cloud.secureUrl;
}
