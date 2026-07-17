import { auth as authAdmin, db } from './firestoreAdmin';
import { logEvent } from './logger';

/**
 * Single source of truth for computing + writing the `role`/`kinfolkId`
 * custom claims from a `clients/{uid}` doc, shared by `onClientsWrite`
 * (fires on every client-doc write) and `setActiveTribe` (needs the claim
 * to land immediately, not whenever the trigger next happens to run).
 *
 * Multi-tribe: `clients/{uid}.kinfolkIds` can have more than one id, but
 * Firestore rules only ever check a single `request.auth.token.kinfolkId`
 * equality — so exactly one id must be "active" at a time. `activeKinfolkId`
 * (also on the client doc) names which one; falls back to `kinfolkIds[0]`
 * when unset or when it names an id the client no longer has (e.g. a tribe
 * link was revoked out from under an active selection).
 */
export async function syncKinfolkClaim(uid: string): Promise<{ kinfolkId: string | null }> {
  const clientSnap = await db().collection('clients').doc(uid).get();
  const data = clientSnap.data();
  const ids = (data?.['kinfolkIds'] ?? []) as string[];
  const requestedActive = data?.['activeKinfolkId'] as string | undefined;
  const activeId = requestedActive && ids.includes(requestedActive) ? requestedActive : (ids[0] ?? null);

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
