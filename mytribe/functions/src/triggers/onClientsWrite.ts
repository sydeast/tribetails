import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { auth as authAdmin, db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { syncKinfolkClaim } from '../lib/kinfolkClaim';

/**
 * Mirrors `clients/{uid}`'s active tribe into Firebase Auth custom claims so
 * AuntieOS firestore + storage rules (`request.auth.token.role == 'kinfolk'`,
 * `request.auth.token.kinfolkId`) see this user. Claim computation itself
 * lives in `syncKinfolkClaim` (shared with `setActiveTribe`, which needs the
 * claim to land immediately rather than waiting on this trigger).
 *
 * Multi-kinfolk-id users: `clients/{uid}.activeKinfolkId` names which one is
 * exposed via claims — set by the portal's TribePicker via the `setActiveTribe`
 * callable (O-5). It no longer falls back to `kinfolkIds[0]`: with 2+ ids and no
 * valid selection, `syncKinfolkClaim` mints NO kinfolk claim and this logs
 * `kinfolkId: null`. That is the designed outcome for a data defect, not a
 * failure — see the contract on `syncKinfolkClaim`.
 */
/**
 * The sign-in account's claims, read before `onClientsWrite` wipes them.
 * `claims: null` with `read: true` means no sign-in account exists (the
 * staff record then decides). `read: false` means the lookup failed.
 */
async function claimsBeforeWipe(
  uid: string,
): Promise<{ read: true; claims: Record<string, unknown> | null } | { read: false }> {
  try {
    const user = await authAdmin().getUser(uid);
    return { read: true, claims: (user.customClaims ?? {}) as Record<string, unknown> };
  } catch (e) {
    if ((e as { code?: unknown })?.code === 'auth/user-not-found') return { read: true, claims: null };
    logEvent({
      severity: 'warn',
      function: 'onClientsWrite',
      event: 'claim.read.failed',
      extra: { uid, err: String(e), note: 'staff access left as it was; the send-time filter still screens her' },
    });
    return { read: false };
  }
}

export const onClientsWrite = onDocumentWritten(
  // AUNTIE_OPERATOR_UIDS so the owner check below sees the allowlist half of
  // "owner" (#2228); without the binding it reads nothing.
  { document: 'clients/{uid}', region: 'us-central1', secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapTrigger('onClientsWrite', async (event) => {
    const uid = event.params.uid;
    const after = event.data?.after.data();
    if (!after) {
      // #2228: read the claims BEFORE they are wiped. Afterwards an owner and
      // an Auntie look the same (no claims at all).
      const before = await claimsBeforeWipe(uid);

      // Doc deleted, clear claims (best-effort; do not throw)
      try {
        await authAdmin().setCustomUserClaims(uid, null);
      } catch (e) {
        logEvent({ severity: 'warn', function: 'onClientsWrite', event: 'claim.clear.failed', extra: { uid, err: String(e) } });
      }

      // #2228: wiping the claims ends an Auntie's staff role, so she also
      // leaves the business admin list and her work devices are unregistered
      // from business notices, in one logged step. Only when her claims or her
      // staff record say Auntie: an ordinary household deletion changes
      // nothing here, and an owner is never removed. When the account could
      // not be read, nothing is changed: dropping the owner over a lookup
      // blip is worse than a stale entry the send-time filter still screens.
      if (before.read) {
        try {
          const { endStaffBusinessAccess } = await import('../lib/staffAccessEnd.js');
          await endStaffBusinessAccess({
            uid,
            claimsBefore: before.claims,
            source: 'onClientsWrite',
          });
        } catch (e) {
          logEvent({
            severity: 'error',
            function: 'onClientsWrite',
            event: 'staffAccess.end.failed',
            extra: { uid, err: String(e) },
          });
        }
      }
      // Clear the household back-link, but ONLY where it is this account's
      // (#1085). This used to merge `{ uid: '' }` into kinfolkIds[0] blind:
      // a deleted test account whose first household belonged to a real
      // primary wiped the real link, and a household already deleted came back
      // as a stub. Each listed household is read in a transaction and cleared
      // only if it exists and its uid is the deleted one. Best-effort.
      try {
        const prevIds = ((event.data?.before.data()?.kinfolkIds ?? []) as unknown[]).filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        );
        for (const kinfolkId of prevIds) {
          const ref = db().collection('kinfolk').doc(kinfolkId);
          await db().runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (snap.exists && snap.data()?.uid === uid) {
              tx.set(ref, { uid: '' }, { merge: true });
            }
          });
        }
      } catch (e) {
        logEvent({ severity: 'warn', function: 'onClientsWrite', event: 'kinfolk.uid.backwrite.failed', extra: { uid, err: String(e) } });
      }
      return;
    }

    try {
      const { kinfolkId } = await syncKinfolkClaim(uid);
      logEvent({
        severity: 'info',
        function: 'onClientsWrite',
        event: 'claim.synced',
        extra: { uid, kinfolkId, ids: ((after.kinfolkIds ?? []) as string[]).length },
      });
    } catch (e) {
      logEvent({ severity: 'warn', function: 'onClientsWrite', event: 'claim.sync.failed', extra: { uid, err: String(e) } });
    }
  }),
);
