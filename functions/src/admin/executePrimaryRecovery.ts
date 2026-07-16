import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { sendFromTemplate } from '../lib/sendFromTemplate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { FULL_PERMISSIONS, INVITE_TTL_DAYS } from '../lib/schema';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  familyId: z.string().min(1),
  recoveryRequestId: z.string().optional(),
  newEmail: z.string().email(),
  oldUid: z.string().optional(),
});

export async function executePrimaryRecoveryHandler(req: CallableRequest<unknown>): Promise<{ inviteId: string }> {
  const args = Args.parse(req.data);
  if (args.oldUid) {
    await db().doc(`families/${args.familyId}/members/${args.oldUid}`).update({
      status: 'SUSPENDED', updatedAt: FieldValue.serverTimestamp(),
    });
  }
  const inviteRef = db().collection('inviteRequests').doc();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000);
  await inviteRef.set({
    tribeId: args.familyId,
    primaryUid: '',
    invitedEmail: args.newEmail.toLowerCase(),
    proposedRole: 'PRIMARY',
    proposedPermissions: FULL_PERMISSIONS,
    requiresAuntieAck: false,
    status: 'EMAIL_SENT',
    createdAt: FieldValue.serverTimestamp(),
    sentToInviteeAt: FieldValue.serverTimestamp(),
    expiresAt,
  });
  await sendFromTemplate('recovery.completed', args.newEmail, {
    tribeName: args.familyId,
    claimUrl: `${process.env.CLAIM_LINK_BASE_URL}?invite=${inviteRef.id}`,
  });
  await writeAuditEntry({
    event: AUDIT_EVENTS.AUTH_RECOVERY_TRIGGERED,
    severity: 'critical',
    actorRole: 'AUNTIE', actorUid: req.auth!.uid,
    targetUid: args.oldUid,
    familyId: args.familyId,
    payload: { newEmail: args.newEmail, recoveryRequestId: args.recoveryRequestId },
  });
  if (args.recoveryRequestId) {
    await db().doc(`recoveryRequests/${args.recoveryRequestId}`).update({
      status: 'COMPLETED', completedAt: FieldValue.serverTimestamp(),
    });
  }
  return { inviteId: inviteRef.id };
}

export const executePrimaryRecovery = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SMTP2GO_API_KEY', 'EMAIL_FROM', 'SENTRY_DSN'] },
  wrapAdminCallable('executePrimaryRecovery', executePrimaryRecoveryHandler),
);
