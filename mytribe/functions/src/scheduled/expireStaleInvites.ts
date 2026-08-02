import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { wrapScheduled } from '../lib/wrapScheduled';
import { enqueueNotification } from '../notifications/dispatcher';
import { logEvent } from '../lib/logger';
import { SERIAL } from '../lib/runtimeOptions';

/**
 * Sweep PENDING/EMAIL_SENT invites past their `expiresAt`: mark EXPIRED, audit, and
 * emit the Business-bucket "invite expired" notification per invite. Extracted from
 * the schedule wrapper so it is unit-testable. Returns how many were expired.
 */
export async function expireStaleInvitesCore(now: Date): Promise<{ expired: number }> {
  const snap = await db().collection('inviteRequests')
    .where('status', 'in', ['PENDING', 'EMAIL_SENT'])
    .where('expiresAt', '<', now)
    .limit(500).get();
  let expired = 0;
  for (const d of snap.docs) {
    const data = d.data() as { tribeId: string; invitedEmail?: string };
    await d.ref.update({ status: 'EXPIRED' });
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.MEMBERSHIP_INVITE_EXPIRED,
      severity: 'info', actorRole: 'SYSTEM',
      familyId: data.tribeId,
      payload: { inviteId: d.id },
    });
    // Run-4: "Kinfolk's MyTribe Invite Expired" (Business bucket). Best-effort, so a
    // dispatch failure never blocks the rest of the expiry sweep.
    try {
      await enqueueNotification({
        key: 'invite.expired',
        data: { kinfolkId: data.tribeId, inviteId: d.id, invitedEmail: data.invitedEmail ?? '' },
      });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'expireStaleInvites',
        event: 'notification.dispatch.failed',
        extra: { inviteId: d.id, key: 'invite.expired', err: (err as Error)?.message },
      });
    }
    expired += 1;
  }
  return { expired };
}

export const expireStaleInvites = onSchedule(
  // Marks lapsed invites overnight. Keeps the 0.25 vCPU fleet default.
  { schedule: 'every day 02:00', timeZone: 'America/New_York', secrets: ['SENTRY_DSN'], ...SERIAL },
  wrapScheduled('expireStaleInvites', async () => {
    await expireStaleInvitesCore(new Date());
  }),
);
