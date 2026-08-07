import { auth as authAdmin, db } from './firestoreAdmin';
import { logEvent } from './logger';

/**
 * The one decision in this file: which household, if any, this uid's claim may
 * name. Returns null when no single household is determined — see the contract
 * on `syncKinfolkClaim`.
 */
function resolveActiveId(uid: string, ids: string[], requestedActive: string | undefined): string | null {
  if (ids.length === 0) return null;
  if (requestedActive && ids.includes(requestedActive)) return requestedActive;
  if (ids.length === 1) return ids[0]!;

  // 2+ ids and nothing valid names one of them. Both arms refuse; they are
  // logged apart because they mean different things operationally — an invalid
  // request is a revoked or corrupted selection on an account that HAS used the
  // picker, no request at all is an account that never could. (An empty-string
  // activeKinfolkId counts as no request, not a bad one, so it does not raise
  // the louder alarm.)
  logEvent(
    requestedActive
      ? {
          severity: 'error', function: 'syncKinfolkClaim', event: 'kinfolk.claim.refused.unknownActiveId',
          uid,
          extra: {
            idCount: ids.length, requestedActive,
            note: 'activeKinfolkId names a household this client does not have; claim cleared rather than substituting another',
          },
        }
      : {
          severity: 'warn', function: 'syncKinfolkClaim', event: 'kinfolk.claim.refused.ambiguous',
          uid,
          extra: {
            idCount: ids.length,
            note: 'account has 2+ kinfolkIds and no active selection; claim cleared rather than designating one. Account needs attention.',
          },
        },
  );
  return null;
}

/**
 * Single source of truth for computing + writing the `role`/`kinfolkId`
 * custom claims from a `clients/{uid}` doc, shared by `onClientsWrite`
 * (fires on every client-doc write) and `setActiveTribe` (needs the claim
 * to land immediately, not whenever the trigger next happens to run).
 *
 * Multi-tribe: `clients/{uid}.kinfolkIds` can have more than one id, but
 * Firestore rules only ever check a single `request.auth.token.kinfolkId`
 * equality — so at most one id can be "active" at a time. `activeKinfolkId`
 * (also on the client doc, written only by `setActiveTribe`, which validates
 * membership first — it is NOT in the client-writable allowlist in
 * firestore.rules) names which one.
 *
 * This mints an authorization claim, so it only mints when the household is
 * UNIQUELY DETERMINED, and never when picking one would be a choice:
 *
 *   0 ids                          -> no claim
 *   activeKinfolkId is one of ids  -> that one (explicit and authorized)
 *   exactly 1 id                   -> that one, whatever activeKinfolkId says;
 *                                     a singleton is not a guess
 *   2+ ids, no valid request       -> NO claim, logged loudly
 *
 * It used to fall back to `kinfolkIds[0]` for the last case. Two ways that was
 * wrong. A 2+-household non-operator is a data defect under the "one kinfolk,
 * one tribe" ruling (2026-08-06) — both clients already dead-end it rather than
 * auto-pick (web `lib/activeTribe.ts`, Android `launch/LaunchRouter.kt`), so the
 * claim was the last path by which such an account could still reach a household
 * nobody chose, via the direct Firestore/Storage reads the rules gate. And when
 * `activeKinfolkId` named an id the client no longer has — i.e. a tribe link was
 * revoked out from under an active selection — falling back handed them a
 * DIFFERENT household instead of refusing.
 *
 * Refusing means clearing the claim, never throwing. Every caller
 * (`onClientsWrite`, `acceptInvite`) catches and warns around this, so a throw
 * would leave the PREVIOUS claim minted — on revocation that keeps the revoked
 * household readable indefinitely, which is worse than the bug. Clearing is the
 * only fail-closed option.
 *
 * The 1-id arm is what keeps this from being a lockout. Under the ruling that is
 * every legitimate non-operator, and it is the arm with no self-heal: Android's
 * single-tribe path routes to `LaunchDestination.Home` and never calls
 * `setActiveTribe`, so a refusal there would strand a real household with no
 * picker to recover through. A 2+ account recovers the moment someone picks
 * (`setActiveTribe` writes a validated `activeKinfolkId`, then re-syncs).
 */
export async function syncKinfolkClaim(uid: string): Promise<{ kinfolkId: string | null }> {
  const clientSnap = await db().collection('clients').doc(uid).get();
  const data = clientSnap.data();
  const ids = (data?.['kinfolkIds'] ?? []) as string[];
  const requestedActive = data?.['activeKinfolkId'] as string | undefined;
  const activeId = resolveActiveId(uid, ids, requestedActive);

  const user = await authAdmin().getUser(uid);
  const existing = (user.customClaims ?? {}) as Record<string, unknown>;
  // Preserve any other claim (e.g. admin) — never replace wholesale.
  const next: Record<string, unknown> = {
    ...existing,
    role: activeId ? 'kinfolk' : (existing['role'] === 'kinfolk' ? null : existing['role']),
    kinfolkId: activeId,
  };
  if (next['role'] == null) delete next['role'];
  if (next['kinfolkId'] == null) delete next['kinfolkId'];
  await authAdmin().setCustomUserClaims(uid, next);

  if (activeId) {
    // Best-effort uid backwrite so rules/FCM resolve the currently-active
    // kinfolk doc to this uid — never throws, mirrors onClientsWrite.
    try {
      await db().collection('kinfolk').doc(activeId).set({ uid }, { merge: true });
    } catch (e) {
      logEvent({
        severity: 'warn', function: 'syncKinfolkClaim', event: 'kinfolk.uid.backwrite.failed',
        extra: { uid, kinfolkId: activeId, err: String(e) },
      });
    }
  }

  return { kinfolkId: activeId };
}
