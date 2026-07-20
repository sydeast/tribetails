import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { syncKinfolkClaim } from '../lib/kinfolkClaim';

const Args = z.object({ kinfolkId: z.string().min(1) });

/**
 * O-5: re-mints the `kinfolkId` custom claim after a multi-tribe kinfolk
 * picks a tribe in TribePicker. Before this callable existed, TribePicker's
 * selection (`web/src/lib/activeTribe.ts`) was purely client-side
 * (sessionStorage) — callable reads honor it because they take an explicit
 * `kinfolkId` arg, but DIRECT Firestore reads gated by
 * `request.auth.token.kinfolkId` (live GPS breadcrumbs, `kin_care_reports`,
 * `kin_care_sessions` rules) always saw whichever tribe was `kinfolkIds[0]`
 * at claim-mint time, regardless of what the picker showed.
 *
 * Writes `clients/{uid}.activeKinfolkId`, then calls the SAME claim-sync
 * logic `onClientsWrite`'s trigger uses (`syncKinfolkClaim`) directly —
 * immediately, not eventually-consistent via the trigger firing on its own
 * schedule — so the picker can force a token refresh right after and have
 * it actually take effect.
 */
export async function setActiveTribeHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; kinfolkId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  const clientRef = db().collection('clients').doc(uid);
  const clientSnap = await clientRef.get();
  const allowed = (clientSnap.data()?.['kinfolkIds'] ?? []) as string[];
  if (!allowed.includes(args.kinfolkId)) {
    throw new HttpsError('permission-denied', 'You do not have access to this tribe.');
  }

  await clientRef.set({ activeKinfolkId: args.kinfolkId }, { merge: true });
  const { kinfolkId } = await syncKinfolkClaim(uid);

  logEvent({
    severity: 'info',
    function: 'setActiveTribe',
    event: 'portal.activeTribe.switched',
    uid,
    extra: { kinfolkId },
  });

  return { ok: true, kinfolkId: args.kinfolkId };
}

export const setActiveTribe = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('setActiveTribe', setActiveTribeHandler),
);
