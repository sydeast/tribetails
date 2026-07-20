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
 * exposed via claims (falls back to `kinfolkIds[0]`) — set by the portal's
 * TribePicker via the `setActiveTribe` callable (O-5).
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
      // Clear uid backwrite on the previously linked kinfolk doc (best-effort)
      try {
        const prevIds = (event.data?.before.data()?.kinfolkIds ?? []) as string[];
        const prevId = prevIds[0] ?? null;
        if (prevId) {
          await db().collection('kinfolk').doc(prevId).set({ uid: '' }, { merge: true });
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
