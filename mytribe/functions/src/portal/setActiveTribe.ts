import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { isStaff } from '../lib/staffGate';
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
): Promise<{ ok: true; kinfolkId: string; claimReminted: boolean }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  const clientRef = db().collection('clients').doc(uid);
  const clientSnap = await clientRef.get();
  const allowed = (clientSnap.data()?.['kinfolkIds'] ?? []) as string[];

  if (!allowed.includes(args.kinfolkId)) {
    // An operator stepping into a household that is not theirs is a legitimate
    // action, not a permission error, and it used to throw here. The client
    // caught that throw into a console.warn, so every operator tribe-switch
    // logged a swallowed permission-denied.
    //
    // It returns WITHOUT writing activeKinfolkId or re-minting, deliberately.
    // syncKinfolkClaim re-validates activeKinfolkId against this caller's own
    // kinfolkIds and would fall back to kinfolkIds[0] regardless, so the write
    // buys nothing. Forcing it through would be actively harmful: the claim
    // sync back-writes `kinfolk/{activeId}.uid = uid`, which would overwrite
    // the real kinfolk's uid on their own doc and break push targeting for that
    // household.
    //
    // Operator impersonation therefore stays claim-less by design, and the
    // rules that gate direct client reads (kin_care_sessions, breadcrumbs,
    // conversations) already carry an isAuntie() branch for exactly this.
    // NOTE: that branch is the `admin` custom claim only. An operator who is on
    // the AUNTIE_OPERATOR_UIDS allowlist but has no minted claim fails those
    // reads, and no server change can fix it, because rules cannot consult an
    // env allowlist. Mint the claim via setAdminClaim (see RULING O-6 step 6).
    if (isStaff(uid, req.auth?.token?.admin === true, 'setActiveTribe')) {
      logEvent({
        severity: 'info',
        function: 'setActiveTribe',
        event: 'portal.activeTribe.operatorView',
        uid,
        extra: {
          kinfolkId: args.kinfolkId,
          note: 'operator viewing a foreign household; claim not re-minted by design',
          hasAdminClaim: req.auth?.token?.admin === true,
        },
      });
      return { ok: true, kinfolkId: args.kinfolkId, claimReminted: false };
    }
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

  return { ok: true, kinfolkId: args.kinfolkId, claimReminted: true };
}

export const setActiveTribe = onCall(
  // AUNTIE_OPERATOR_UIDS is required because isStaff reads it. Binding it is not
  // optional: without it the allowlist arm of isStaff silently evaluates false.
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('setActiveTribe', setActiveTribeHandler),
);
