import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { wrapScheduled } from '../lib/wrapScheduled';

export const cleanupExpiredShareLinks = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'America/New_York', secrets: ['SENTRY_DSN'] },
  wrapScheduled('cleanupExpiredShareLinks', async () => {
    const now = new Date();
    const snap = await db().collection('sharedKinTales')
      .where('revoked', '==', false)
      .where('expiresAt', '<', now)
      .limit(500).get();
    for (const d of snap.docs) {
      await d.ref.update({ revoked: true });
      await writeAuditEntry({
        event: AUDIT_EVENTS.CONTENT_SHARE_LINK_EXPIRED,
        severity: 'info', actorRole: 'SYSTEM',
        familyId: (d.data() as { tribeId: string }).tribeId,
        payload: { shareId: d.id },
      });
    }
  }),
);
