import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { wrapScheduled } from '../lib/wrapScheduled';

/**
 * Sweep unrevoked share links past their `expiresAt`: revoke each and audit it.
 * Extracted from the schedule wrapper so its one query is unit-testable, the
 * same shape as `expireStaleInvitesCore`. Returns how many were revoked.
 */
export async function cleanupExpiredShareLinksCore(now: Date): Promise<{ revoked: number }> {
  const snap = await db().collection('sharedKinTales')
    .where('revoked', '==', false)
    .where('expiresAt', '<', now)
    .limit(500).get();
  let revoked = 0;
  for (const d of snap.docs) {
    await d.ref.update({ revoked: true });
    await writeAuditEntry({
      event: AUDIT_EVENTS.CONTENT_SHARE_LINK_EXPIRED,
      severity: 'info', actorRole: 'SYSTEM',
      familyId: (d.data() as { tribeId: string }).tribeId,
      payload: { shareId: d.id },
    });
    revoked += 1;
  }
  return { revoked };
}

export const cleanupExpiredShareLinks = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'America/New_York', secrets: ['SENTRY_DSN'] },
  wrapScheduled('cleanupExpiredShareLinks', async () => {
    await cleanupExpiredShareLinksCore(new Date());
  }),
);
