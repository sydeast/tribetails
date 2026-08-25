import * as crypto from 'crypto';

export interface CloudinarySignedUpload {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  allowedFormats: string;
  /**
   * #583. The incoming transformation the server signed. Always
   * `fl_force_strip` here: every folder this signer scopes is a photo folder
   * (kin photos, kinfolk avatars), so there is no non-image case. Part of the
   * signature base, so a client MUST echo it verbatim in the upload POST.
   */
  transformation: string;
}

/** Image formats every signed upload is constrained to, both at Cloudinary
 *  (via the signed `allowed_formats` param) and at our own confirm-side
 *  validation. Cloudinary's classic multi-param signature only covers body
 *  params, not the `resource_type` segment of the upload URL — a client
 *  holding a valid `folder`+`timestamp` signature could otherwise POST it to
 *  `/raw/upload` or `/video/upload` and store arbitrary non-image content.
 *  Signing `allowed_formats` closes that at the source. */
const ALLOWED_IMAGE_FORMATS = 'jpg,png,webp,gif';

/** #583: photo location metadata does not survive an upload.
 *
 *  A photo taken with the phone's location services on carries the coordinates
 *  inside the file, in its EXIF block, before the portal ever sees it. The
 *  bytes go straight from the client to api.cloudinary.com — nothing of ours
 *  touches them in flight — so the only lever is the signature. A param we
 *  sign is a param the client is forced to send verbatim; a param we do not
 *  sign it cannot add. So the strip instruction is signed.
 *
 *  `fl_force_strip` is Cloudinary's own flag for this: "Instructs Cloudinary to
 *  clear all image metadata (IPTC, Exif and XMP) while applying an incoming
 *  transformation". Passed as the `transformation` upload param it IS that
 *  incoming transformation, and incoming transformations are applied before
 *  the asset is stored, so the STORED ORIGINAL is the stripped file rather
 *  than a stripped copy of a coordinate-bearing original.
 *
 *  IT IS ALL-OR-NOTHING: the Upload API has no GPS-only option, so capture
 *  time, camera/lens, IPTC and XMP go with the coordinates, and the image is
 *  re-encoded to do it. Cloudinary auto-rotates from the EXIF orientation tag
 *  before stripping (its documented default), so a phone photo does not come
 *  back sideways. */
const STRIP_METADATA_TRANSFORMATION = 'fl_force_strip';

/**
 * Classic Cloudinary signed-upload recipe: sha1(sorted params + api_secret).
 * Every param that should be enforced by Cloudinary itself (not just trusted
 * client-side) MUST be included in the signature base, in alphabetical
 * order, or Cloudinary rejects the request as a signature mismatch.
 */
export function signCloudinaryFolderUpload(params: {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
}): CloudinarySignedUpload {
  const timestamp = Math.floor(Date.now() / 1000);
  // Alphabetical by param name, per Cloudinary's signature recipe:
  // allowed_formats < folder < timestamp < transformation.
  const signatureBase =
    `allowed_formats=${ALLOWED_IMAGE_FORMATS}&folder=${params.folder}&timestamp=${timestamp}` +
    `&transformation=${STRIP_METADATA_TRANSFORMATION}${params.apiSecret}`;
  const signature = crypto.createHash('sha1').update(signatureBase).digest('hex');
  return {
    cloudName: params.cloudName,
    apiKey: params.apiKey,
    timestamp,
    signature,
    folder: params.folder,
    allowedFormats: ALLOWED_IMAGE_FORMATS,
    transformation: STRIP_METADATA_TRANSFORMATION,
  };
}

/**
 * Validates that a client-reported Cloudinary `secure_url` really is: (a) our
 * Cloudinary account, (b) served over https, and (c) inside the exact folder
 * that was signed for this upload. Never persist a client-supplied upload URL
 * without this check — without it, a "confirm my upload" callable degrades to
 * "set my photo to any URL I want," including a URL that never touched our
 * Cloudinary account at all. Throws a plain Error; callers wrap in HttpsError.
 */
export function assertCloudinaryUrlInFolder(secureUrl: string, cloudName: string, folder: string): void {
  let parsed: URL;
  try {
    parsed = new URL(secureUrl);
  } catch {
    throw new Error('Malformed secureUrl.');
  }
  // Exact match, not endsWith — a suffix match would also accept a
  // subdomain like "xres.cloudinary.com" (unregistrable by an attacker
  // since it's still under cloudinary.com, but there's no reason to accept
  // anything but the literal asset host).
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com') {
    throw new Error('secureUrl is not a Cloudinary asset URL.');
  }
  if (!parsed.pathname.startsWith(`/${cloudName}/`)) {
    throw new Error('secureUrl does not match this Cloudinary account.');
  }
  // Cloudinary's signature only covers body params, not the resource_type
  // segment of the upload URL — signing allowed_formats stops Cloudinary
  // accepting a non-image upload, but this is the belt to that suspenders:
  // even if something upstream slipped through, we refuse to persist a
  // photoUrl that isn't an /image/upload/ asset.
  if (!parsed.pathname.startsWith(`/${cloudName}/image/upload/`)) {
    throw new Error('secureUrl is not an image asset.');
  }
  const folderMarker = `/${folder.replace(/^\/+|\/+$/g, '')}/`;
  if (!parsed.pathname.includes(folderMarker)) {
    throw new Error('secureUrl is outside the signed folder.');
  }
}
