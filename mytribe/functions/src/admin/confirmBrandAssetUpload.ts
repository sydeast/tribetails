import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { assertCloudinaryUrlInFolder } from '../lib/cloudinary';
import { BRAND_ASSET_KINDS, BRAND_ASSET_FOLDER, brandAssetFields, type BrandAssetKind } from '../lib/brandAsset';

const CLOUDINARY_CLOUD_NAME = defineSecret('CLOUDINARY_CLOUD_NAME');

/**
 * `secureUrl: null` is the REMOVE action, not a malformed set. Modelled as one
 * callable rather than a `removeBrandAsset` sibling because set and clear write
 * the same two fields on the same doc under the same gate, and a second
 * callable would be a second place for the "what does cleared mean" rule to
 * drift.
 */
export const Args = z.object({
  kind: z.enum(BRAND_ASSET_KINDS),
  secureUrl: z.string().url().max(2000).nullable(),
});

export interface ConfirmBrandAssetUploadResult {
  kind: BrandAssetKind;
  /** The persisted URL, or '' after a removal. */
  logoUrl: string;
  /** ISO instant of the removal that produced this state, or '' when a logo is set or was never set. */
  logoRemovedAt: string;
}

/**
 * Persists (or clears) a brand logo that the operator just uploaded straight to
 * Cloudinary through the existing `/api/cloudinary/sign-upload` signer.
 *
 * WHY THIS EXISTS AT ALL, given `business_settings` is `allow write: if
 * isAuntie()` and the admin could simply `setDoc` the field itself: it is the
 * one place that checks the URL is real before it reaches a client-facing
 * surface. `assertCloudinaryUrlInFolder` proves the string is (a) https, (b)
 * `res.cloudinary.com`, (c) OUR cloud, (d) an `/image/upload/` asset and (e)
 * inside the folder the signer actually signed. Without it, "set my logo"
 * degrades to "point the kinfolk portal's header at any URL on the internet",
 * including one that never touched our account, and a fat-fingered paste
 * becomes a broken image on every client's screen rather than a rejected save.
 *
 * REMOVAL IS RECORDED, NOT JUST BLANKED. A cleared logo and a never-set logo
 * are both `logoUrl === ''`, which would make them indistinguishable and leave
 * an operator unable to tell "I removed this" from "this never worked".
 * `logoRemovedAt` carries the ISO instant of the clear, so the admin can say
 * "Removed on 25 Jul" instead of the same empty state a fresh install shows.
 *
 * THE CLOUDINARY ASSET IS NOT DELETED. Clearing drops the REFERENCE only. The
 * file stays in Cloudinary, deliberately: these functions hold no Cloudinary
 * delete credential, an operator who clears a logo by mistake would otherwise
 * have destroyed it, and the URL may still be live in an already-sent email or
 * a page a browser has cached. The admin's Remove copy says this in as many
 * words rather than implying a deletion that does not happen.
 */
export async function confirmBrandAssetUploadHandler(
  req: CallableRequest<unknown>,
): Promise<ConfirmBrandAssetUploadResult> {
  const uid = req.auth!.uid;
  const args = Args.parse(req.data);

  const removing = args.secureUrl === null;
  let logoUrl = '';
  let logoRemovedAt = '';

  if (removing) {
    logoRemovedAt = new Date().toISOString();
  } else {
    const cloudName = CLOUDINARY_CLOUD_NAME.value();
    if (!cloudName) throw new HttpsError('failed-precondition', 'cloudinary_signing_not_configured');
    try {
      assertCloudinaryUrlInFolder(args.secureUrl!, cloudName, BRAND_ASSET_FOLDER);
    } catch (err) {
      throw new HttpsError('invalid-argument', (err as Error).message);
    }
    logoUrl = args.secureUrl!;
  }

  // `merge: true`, and for `portalLogo` a nested map, so this touches exactly
  // two keys and leaves every sibling setting (theme, banner, chat, home
  // layout, and the whole rest of the business doc) untouched.
  await db()
    .collection('business_settings')
    .doc('business_settings')
    .set(
      { ...brandAssetFields(args.kind, logoUrl, logoRemovedAt), updatedAt: new Date().toISOString(), updatedBy: uid },
      { merge: true },
    );

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BRANDING_ASSET_UPDATED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: { kind: args.kind, action: removing ? 'removed' : 'set' },
  });

  logEvent({
    severity: 'info',
    function: 'confirmBrandAssetUpload',
    event: removing ? 'admin.branding.asset.removed' : 'admin.branding.asset.set',
    uid,
    extra: { kind: args.kind },
  });

  return { kind: args.kind, logoUrl, logoRemovedAt };
}

export const confirmBrandAssetUpload = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: [CLOUDINARY_CLOUD_NAME, 'SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapAdminCallable('confirmBrandAssetUpload', confirmBrandAssetUploadHandler),
);
