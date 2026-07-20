import * as crypto from 'crypto';

export interface CloudinarySignedUpload {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  allowedFormats: string;
}

/** Image formats every signed upload is constrained to, both at Cloudinary
 *  (via the signed `allowed_formats` param) and at our own confirm-side
 *  validation. Cloudinary's classic multi-param signature only covers body
 *  params, not the `resource_type` segment of the upload URL — a client
 *  holding a valid `folder`+`timestamp` signature could otherwise POST it to
 *  `/raw/upload` or `/video/upload` and store arbitrary non-image content.
 *  Signing `allowed_formats` closes that at the source. */
const ALLOWED_IMAGE_FORMATS = 'jpg,png,webp,gif';

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
  const signatureBase =
    `allowed_formats=${ALLOWED_IMAGE_FORMATS}&folder=${params.folder}&timestamp=${timestamp}${params.apiSecret}`;
  const signature = crypto.createHash('sha1').update(signatureBase).digest('hex');
  return {
    cloudName: params.cloudName,
    apiKey: params.apiKey,
    timestamp,
    signature,
    folder: params.folder,
    allowedFormats: ALLOWED_IMAGE_FORMATS,
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
