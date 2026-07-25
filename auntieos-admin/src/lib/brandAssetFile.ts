/**
 * Pre-upload validation for a brand logo. EVERY check here runs BEFORE a single
 * byte leaves the browser.
 *
 * That ordering is the whole point of this module. The obvious implementation
 * uploads first and reports the verdict afterwards, which means an operator on
 * a slow connection picks a 12 MB photo from their phone, watches a progress
 * bar for ninety seconds, and is then told the file was never going to be
 * accepted. The information needed to say "no" was available before the upload
 * started. Withholding it until after is the form failing the operator, so a
 * rejection here costs one file-picker interaction and no network at all.
 *
 * These limits are duplicated in `mytribe/functions/src/lib/brandAsset.ts`. The
 * two trees are separate npm packages with no shared module, so the duplication
 * is structural rather than sloppy; both sides pin the values in their own
 * tests so a drift fails a build instead of surfacing as a rejected upload.
 */

/** Cloudinary would accept more, but 5 MB is already far past what a logo needs. */
export const MAX_BRAND_ASSET_BYTES = 5_000_000;

/**
 * SVG IS DELIBERATELY EXCLUDED, though the task's field list named it. Two
 * independent reasons, either sufficient:
 *
 *  1. The deployed signer signs `allowed_formats=jpg,png,webp,gif`, so
 *     Cloudinary itself rejects an SVG. Accepting one here would only move the
 *     failure later and make it more confusing.
 *  2. An SVG is a script-bearing document, and this logo renders on the
 *     CLIENT-FACING kinfolk portal. Accepting operator-supplied SVG turns a
 *     branding field into a stored-XSS surface the moment anything inlines it.
 *
 * GIF is signable but excluded too: an animated logo in a page header is not a
 * thing this product wants to have shipped by accident.
 */
export const ACCEPTED_BRAND_ASSET_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Below this a "logo" is a favicon, and the portal header would scale it into a smear. */
export const MIN_BRAND_ASSET_PX = 48;
/** Above this it is a camera original being shipped to every kinfolk on every page load. */
export const MAX_BRAND_ASSET_PX = 4000;

const TYPE_LABEL = 'PNG, JPEG, or WebP';

export interface BrandAssetRejection {
  ok: false;
  /** Operator-facing, names the actual value and the limit, never just "invalid file". */
  reason: string;
}
export interface BrandAssetAccepted {
  ok: true;
  width: number;
  height: number;
}
export type BrandAssetCheck = BrandAssetAccepted | BrandAssetRejection;

/** Just enough of `File` to be checkable without constructing one in a test. */
export interface CheckableFile {
  type: string;
  size: number;
}

export type ImageDecoder = (file: Blob) => Promise<{ width: number; height: number }>;

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * The synchronous half: type and size. Separated from the dimension check
 * because these two need no decode, so a 12 MB file is refused without ever
 * being read into memory.
 */
export function checkBrandAssetMeta(file: CheckableFile): BrandAssetRejection | null {
  if (!(ACCEPTED_BRAND_ASSET_TYPES as readonly string[]).includes(file.type)) {
    const got = file.type.trim() === '' ? 'an unrecognised type' : file.type;
    return { ok: false, reason: `That file is ${got}. Logos must be ${TYPE_LABEL}.` };
  }
  if (file.size > MAX_BRAND_ASSET_BYTES) {
    return {
      ok: false,
      reason: `That file is ${mb(file.size)}. The limit is ${mb(MAX_BRAND_ASSET_BYTES)}, so nothing was uploaded.`,
    };
  }
  if (file.size === 0) {
    return { ok: false, reason: 'That file is empty, so there is nothing to upload.' };
  }
  return null;
}

/** Decodes just far enough to read intrinsic dimensions, then releases the bitmap. */
const defaultDecoder: ImageDecoder = async (file) => {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode failed'));
    };
    img.src = url;
  });
};

/**
 * Full check: type, size, then intrinsic pixel dimensions. Returns the decoded
 * size on success so the caller can show it beside the preview.
 *
 * A file that will not decode is REFUSED, not waved through. A browser that
 * cannot read the image is strong evidence the bytes are not the image type the
 * file claims, which is exactly the case that would otherwise upload
 * successfully and then render as a broken logo on the client-facing portal.
 */
export async function checkBrandAssetFile(
  file: File,
  decode: ImageDecoder = defaultDecoder,
): Promise<BrandAssetCheck> {
  const meta = checkBrandAssetMeta(file);
  if (meta) return meta;

  let size: { width: number; height: number };
  try {
    size = await decode(file);
  } catch {
    return {
      ok: false,
      reason: `That file could not be read as an image. Re-export it as ${TYPE_LABEL} and try again.`,
    };
  }

  if (size.width < MIN_BRAND_ASSET_PX || size.height < MIN_BRAND_ASSET_PX) {
    return {
      ok: false,
      reason: `That image is ${size.width}x${size.height}. Logos need to be at least ${MIN_BRAND_ASSET_PX}px on both sides.`,
    };
  }
  if (size.width > MAX_BRAND_ASSET_PX || size.height > MAX_BRAND_ASSET_PX) {
    return {
      ok: false,
      reason: `That image is ${size.width}x${size.height}. The limit is ${MAX_BRAND_ASSET_PX}px on either side.`,
    };
  }
  return { ok: true, width: size.width, height: size.height };
}
