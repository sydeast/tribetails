import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * dismissBanner: records the per-user dismissal of a portal banner.
 *
 * Backs the `dismissMode: "perUser"` banner mode (§5 of the portal-settings
 * spec). The MyTribe top banner's X calls this with the banner's stable id;
 * `getMyHome` then suppresses any banner whose id is in
 * `clients/{uid}.dismissedBanners`. Bumping the banner's id in admin re-shows it
 * because the new id won't be in the dismissed set.
 *
 * Auth: any signed-in kinfolk; scoped to their own `clients/{uid}` doc, so a user
 * can only ever dismiss banners for themselves. arrayUnion keeps it idempotent
 * (re-dismissing the same id is a no-op) and append-only.
 */

const Args = z.object({
  bannerId: z.string().min(1).max(200),
});

export async function dismissBannerHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'dismissBanner validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  // Append the banner id to the caller's dismissed set. merge:true so this never
  // clobbers other client fields; arrayUnion dedupes and creates the array if absent.
  await db().collection('clients').doc(uid).set(
    {
      dismissedBanners: FieldValue.arrayUnion(args.bannerId),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  logEvent({
    severity: 'info',
    function: 'dismissBanner',
    event: 'portal.banner.dismissed',
    uid,
    extra: { bannerId: args.bannerId },
  });

  return { ok: true };
}

export const dismissBanner = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('dismissBanner', dismissBannerHandler),
);
