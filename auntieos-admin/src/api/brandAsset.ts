import { call } from '../lib/fns';
import { requestSignedUpload, uploadToCloudinary, BUSINESS_ENTITY_ID } from './mediaUpload';
import { checkBrandAssetFile, type ImageDecoder } from '../lib/brandAssetFile';

/**
 * Brand logo upload, THROUGH THE UPLOAD PATH THIS APP ALREADY HAS.
 *
 * `api/mediaUpload.ts` already signs against `/api/cloudinary/sign-upload` and
 * POSTs to Cloudinary, and its `BUSINESS` target is literally
 * `business_settings`, the logo. Android's `MediaUploadManager` uploads the
 * logo through that same endpoint with the same entity today. So this module
 * adds NO signing code and NO second pipeline: it reuses `requestSignedUpload`
 * and `uploadToCloudinary` verbatim and only changes what happens to the URL at
 * the end.
 *
 * The one thing it does NOT reuse is `writeMediaFileDoc`. A logo is not gallery
 * media; filing it into `media_files` would put the operator's logo in the
 * Gallery grid as though it were a photo of a pet. Android does exactly that
 * today (`MediaUploadManager.uploadMedia` writes the doc as a side effect), and
 * it is why an abandoned Android logo upload leaves an orphan gallery row. This
 * path writes the settings doc instead, through `confirmBrandAssetUpload`.
 *
 * ── CACHING: WHY A REPLACED LOGO IS NOT STALE ───────────────────────────────
 *
 * The usual trap here is a STABLE asset URL: replace the file behind
 * `.../logo.png` and every browser, CDN and service worker keeps serving the old
 * bytes, so the operator uploads a new logo and swears nothing happened. That
 * cannot occur on this path, and it is worth writing down because it is a
 * property of the pipeline rather than an accident:
 *
 *  1. `uploadToCloudinary` sends file/api_key/timestamp/signature/folder and NO
 *     `public_id` and NO `overwrite`. Cloudinary therefore mints a fresh random
 *     public id per upload, and the delivery URL also carries its own `/v.../`
 *     version segment. A replacement is a DIFFERENT URL, so it is a different
 *     cache key everywhere and cannot collide with the old one. Nothing needs
 *     busting; the stale entry simply stops being requested. (The corollary is
 *     the removal note above: the old asset is still sitting in Cloudinary.)
 *  2. The kinfolk portal's service worker never caches it. `mytribe/web/src/sw.ts`
 *     precaches only local build output, runs NetworkFirst for navigations and
 *     NetworkOnly for Firebase hosts, and has no runtime route for
 *     `res.cloudinary.com` or for `request.destination === 'image'` at all.
 *  3. The URL itself reaches the portal on the `getMyHome` callable payload, a
 *     POST to cloudfunctions.net, which that same NetworkOnly rule excludes from
 *     the service worker. Its only cache is TanStack Query's, where PortalNav
 *     holds it for five minutes while Home and Account keep refetching on mount.
 */

export type BrandAssetKind = 'businessLogo' | 'portalLogo';

export interface ConfirmBrandAssetResult {
  kind: BrandAssetKind;
  logoUrl: string;
  logoRemovedAt: string;
}

/** The real pipeline stages, so the button can name what is happening instead of inventing a percentage. */
export type BrandUploadStage = 'checking' | 'signing' | 'uploading' | 'saving';

export interface UploadBrandAssetInput {
  kind: BrandAssetKind;
  file: File;
  onStage?: (stage: BrandUploadStage) => void;
  /** Test seam for the intrinsic-dimension decode; production uses the browser. */
  decode?: ImageDecoder;
}

/**
 * Validate, sign, upload, then persist server-side.
 *
 * VALIDATION IS FIRST AND IS NOT NEGOTIABLE. `checkBrandAssetFile` runs before
 * `requestSignedUpload`, so a file that was never going to be accepted costs
 * zero network. A rejection throws with the operator-facing reason, which is
 * the same channel every other failure here uses, so the caller has one error
 * surface rather than two.
 */
export async function uploadBrandAsset(input: UploadBrandAssetInput): Promise<ConfirmBrandAssetResult> {
  input.onStage?.('checking');
  const check = await checkBrandAssetFile(input.file, input.decode);
  if (!check.ok) throw new Error(check.reason);

  input.onStage?.('signing');
  const sign = await requestSignedUpload('BUSINESS', BUSINESS_ENTITY_ID);

  input.onStage?.('uploading');
  const cloud = await uploadToCloudinary(input.file, sign);

  // The server re-validates that this URL is genuinely a Cloudinary image asset
  // inside the folder that was signed. It is the only check standing between a
  // client-supplied string and the kinfolk portal's header, so the client never
  // writes `logoUrl` itself even though firestore.rules would permit it.
  input.onStage?.('saving');
  return confirmBrandAsset(input.kind, cloud.secureUrl);
}

/** Persist an already-uploaded URL. Split out so a retry after a failed save does not re-upload the file. */
export function confirmBrandAsset(kind: BrandAssetKind, secureUrl: string): Promise<ConfirmBrandAssetResult> {
  return call<{ kind: BrandAssetKind; secureUrl: string }, ConfirmBrandAssetResult>(
    'confirmBrandAssetUpload',
    { kind, secureUrl },
  );
}

/**
 * Clear a logo. `secureUrl: null` is the remove action on the same callable,
 * which stamps `logoRemovedAt` so a cleared logo stays distinguishable from one
 * that was never set.
 *
 * THE CLOUDINARY FILE IS NOT DELETED, only the reference. That is deliberate
 * and the UI says so: these functions hold no Cloudinary delete credential, a
 * mistaken removal would otherwise be unrecoverable, and the URL may still be
 * live in an already-sent email or a browser cache.
 */
export function removeBrandAsset(kind: BrandAssetKind): Promise<ConfirmBrandAssetResult> {
  return call<{ kind: BrandAssetKind; secureUrl: null }, ConfirmBrandAssetResult>(
    'confirmBrandAssetUpload',
    { kind, secureUrl: null },
  );
}
