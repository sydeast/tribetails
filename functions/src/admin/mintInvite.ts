import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { sendFromTemplate } from '../lib/sendFromTemplate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { INVITE_TTL_DAYS, SECONDARY_LABEL_MAX } from '../lib/schema';
import { TRIBETAILS_CORS } from '../lib/cors';

const PermSchema = z.object({
  billing_full: z.boolean(),
  messaging_direct: z.boolean(),
  messaging_group: z.boolean(),
  kin_edit: z.boolean(),
  kintales_only: z.boolean(),
  home_access: z.boolean(),
});

const Args = z.object({
  familyId: z.string().min(1),
  invitedEmail: z.string().email(),
  secondaryLabel: z.string().max(SECONDARY_LABEL_MAX).optional().default('Folk'),
  proposedPermissions: PermSchema,
  proposedRole: z.enum(['PRIMARY', 'SECONDARY']).default('SECONDARY'),
});

function sanitizeLabel(s: string): string {
  return s.replace(/[<>{} -]/g, '').trim().slice(0, SECONDARY_LABEL_MAX) || 'Folk';
}

export async function mintInviteHandler(req: CallableRequest<unknown>): Promise<{ inviteId: string }> {
  const args = Args.parse(req.data);
  const proposedPermissions = { ...args.proposedPermissions, kintales_only: true };
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000);
  const ref = await db().collection('inviteRequests').add({
    tribeId: args.familyId,
    primaryUid: '',
    invitedEmail: args.invitedEmail.toLowerCase(),
    secondaryLabel: sanitizeLabel(args.secondaryLabel),
    proposedPermissions,
    proposedRole: args.proposedRole,
    requiresAuntieAck: false,
    status: 'PENDING',
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });
  const tplKey = args.proposedRole === 'PRIMARY' ? 'invite.primary' : 'invite.secondary';
  await sendFromTemplate(tplKey, args.invitedEmail, {
    primaryDisplayName: 'Auntie',
    secondaryDisplayName: args.invitedEmail,
    secondaryLabel: sanitizeLabel(args.secondaryLabel),
    tribeName: args.familyId,
    claimUrl: `${process.env.CLAIM_LINK_BASE_URL}?invite=${ref.id}`,
    expiresInDays: INVITE_TTL_DAYS,
  });
  await ref.update({ status: 'EMAIL_SENT', sentToInviteeAt: FieldValue.serverTimestamp() });
  await writeAuditEntry({
    event: AUDIT_EVENTS.MEMBERSHIP_INVITE_SENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: req.auth!.uid,
    familyId: args.familyId,
    payload: { inviteId: ref.id, invitedEmail: args.invitedEmail, role: args.proposedRole },
  });
  return { inviteId: ref.id };
}

export const mintInvite = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SMTP2GO_API_KEY', 'EMAIL_FROM', 'SENTRY_DSN'] },
  wrapAdminCallable('mintInvite', mintInviteHandler),
);
