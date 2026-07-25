/**
 * Brand asset (logo) rules, shared by the confirm callable and the portal read.
 *
 * THERE IS NO SIGNER HERE, AND THAT IS DELIBERATE.
 *
 * The plan for this task called for a `signBrandAssetUpload` callable. It is
 * not built, because a signer for exactly this upload already exists, is
 * deployed, and is what BOTH admin clients already use:
 *
 *   POST /api/cloudinary/sign-upload   (AuntieOS hosting rewrite ->
 *   `signCloudinaryUpload` in auntieos-admin/web/functions/index.js)
 *
 * Android's `MediaUploadManager` calls it with entityType BUSINESS and
 * entityId `business_settings` to upload the workspace logo TODAY, and the
 * React admin's `api/mediaUpload.ts` calls the same endpoint for the same
 * target. Minting a second signer, in a second codebase, for the same operator
 * uploading the same file, is precisely the shape of the incident recorded at
 * the top of `src/index.ts`: two codebases owning one upload concern, whichever
 * deployed last winning, and every signature from the loser rejected. That
 * comment is a rule, not an anecdote, so this module signs nothing.
 *
 * What was genuinely missing is the OTHER half: nothing validated the resulting
 * URL before it was written. That is `confirmBrandAssetUpload`.
 *
 * There is no new READ callable either, for the same reason. `getMyHome`
 * already reads this doc and already returns `businessLogoUrl` plus the whole
 * `portal` config to the kinfolk portal on every Home and Account load. The
 * portal simply threw the branding away (it rendered only `businessName` and
 * `portal.home`). The fix belongs in the portal's markup, not in a second
 * callable re-fetching a payload the client is already holding.
 */

/** The two independently-settable logos. `businessLogo` brands the admin, `portalLogo` brands the kinfolk portal. */
export const BRAND_ASSET_KINDS = ['businessLogo', 'portalLogo'] as const;
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number];

/**
 * The Cloudinary folder the DEPLOYED signer mints for this target, derived the
 * same way by all three callers and therefore not a choice this file gets to
 * make: `signCloudinaryUpload`'s `validateUploadFolder` requires the folder to
 * start with `tribetails/` and END with the entityId segment, and both clients
 * build it as `tribetails/{entityType.toLowerCase()}/{entityId}`.
 *
 * Both logo kinds land in this one folder. They are not separated by folder
 * because separating them would require a second signer to mint a second
 * folder, which is the thing this module refuses to do. Nothing is lost by
 * sharing it: `kind` selects the destination FIELD, and both fields live on one
 * doc that only an Auntie may write, so there is no boundary for a
 * cross-kind confirm to cross.
 */
export const BRAND_ASSET_FOLDER = 'tribetails/business/business_settings';

/**
 * Upload limits. Enforced by the CLIENT before a byte leaves the browser (that
 * is the point: an operator must not discover a 12 MB photo is too big only
 * after the round trip), and restated here because a client-side check is a
 * courtesy, never a guarantee.
 *
 * These numbers are duplicated in `auntieos-admin/src/lib/brandAssetFile.ts`.
 * The two trees are separate npm packages with no shared module, so the
 * duplication is unavoidable; `callableContract.test.ts` pins the values on
 * this side and `brandAssetFile.test.ts` pins them on the other, so a silent
 * drift fails a build rather than surfacing as a rejected upload.
 */
export const MAX_BRAND_ASSET_BYTES = 5_000_000;

/**
 * Accepted image types. SVG IS DELIBERATELY ABSENT, and the plan's field list
 * named it, so this is a considered removal rather than an oversight:
 *
 *  1. The deployed signer signs `allowed_formats=jpg,png,webp,gif`
 *     (`lib/cloudinary.ts`). Cloudinary itself would reject an SVG, so
 *     accepting one here would only move the failure later and make it
 *     stranger.
 *  2. An SVG is a script-bearing document. This logo renders on the
 *     CLIENT-FACING portal. Accepting operator-supplied SVG makes the branding
 *     field a stored-XSS surface the moment anything inlines it rather than
 *     using it as an `<img>` source.
 *
 * A raster logo costs an operator nothing to export and closes both.
 */
export const ACCEPTED_BRAND_ASSET_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * Pixel bounds. The floor stops a favicon being set as a logo and rendering as
 * a smear when the portal scales it up; the ceiling stops a 8000px camera
 * original being shipped to every kinfolk on every page load.
 */
export const MIN_BRAND_ASSET_PX = 48;
export const MAX_BRAND_ASSET_PX = 4000;

/**
 * Firestore field paths each kind writes. `portalLogo` is a nested key on the
 * `mytribePortal` map, which merges rather than replaces, so writing it can
 * never blank the portal's theme, banner, home layout or chat config.
 */
export function brandAssetFields(kind: BrandAssetKind, url: string, removedAt: string): Record<string, unknown> {
  return kind === 'businessLogo'
    ? { logoUrl: url, logoRemovedAt: removedAt }
    : { mytribePortal: { logoUrl: url, logoRemovedAt: removedAt } };
}
