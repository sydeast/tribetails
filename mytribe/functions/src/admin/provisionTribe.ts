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
  displayName: z.string().min(1).max(80),
  primaryEmail: z.string().email(),
  primaryPhone: z.string().optional(),
});

export async function provisionTribeHandler(req: CallableRequest<unknown>): Promise<{ familyId: string; inviteId: string }> {
  const args = Args.parse(req.data);
  const familyRef = db().collection('families').doc();
  const inviteRef = db().collection('inviteRequests').doc();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000);
  await db().runTransaction(async (tx) => {
    tx.set(familyRef, {
      displayName: args.displayName,
      primaryUid: '',
      themeConfigRef: `families/${familyRef.id}/themeConfig/active`,
      flags: { tribePinSet: false, tribePinChangePending: false, unverified: false },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(db().doc(`families/${familyRef.id}/themeConfig/active`), {
      brandTokens: {}, kinfolkOverrides: {}, updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(inviteRef, {
      tribeId: familyRef.id,
      primaryUid: '',
      invitedEmail: args.primaryEmail.toLowerCase(),
      invitedPhone: args.primaryPhone,
      proposedRole: 'PRIMARY',
      proposedPermissions: FULL_PERMISSIONS,
      requiresAuntieAck: false,
      status: 'PENDING',
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
    });
  });
  await sendFromTemplate('invite.primary', args.primaryEmail, {
    primaryDisplayName: args.primaryEmail,
    tribeName: args.displayName,
    claimUrl: `${process.env.CLAIM_LINK_BASE_URL}?invite=${inviteRef.id}`,
    expiresInDays: INVITE_TTL_DAYS,
  });
  await inviteRef.update({ status: 'EMAIL_SENT', sentToInviteeAt: FieldValue.serverTimestamp() });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MEMBERSHIP_TRIBE_PROVISIONED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: req.auth!.uid,
    familyId: familyRef.id,
    payload: { displayName: args.displayName, primaryEmail: args.primaryEmail },
  });
  return { familyId: familyRef.id, inviteId: inviteRef.id };
}

export const provisionTribe = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SMTP2GO_API_KEY', 'EMAIL_FROM', 'SENTRY_DSN'] },
  wrapAdminCallable('provisionTribe', provisionTribeHandler),
);
