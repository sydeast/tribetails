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
export const onClientsWrite = onDocumentWritten(
  { document: 'clients/{uid}', region: 'us-central1', secrets: ['SENTRY_DSN'] },
  wrapTrigger('onClientsWrite', async (event) => {
    const uid = event.params.uid;
    const after = event.data?.after.data();
    if (!after) {
      // Doc deleted, clear claims (best-effort; do not throw)
      try {
        await authAdmin().setCustomUserClaims(uid, null);
      } catch (e) {
        logEvent({ severity: 'warn', function: 'onClientsWrite', event: 'claim.clear.failed', extra: { uid, err: String(e) } });
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
