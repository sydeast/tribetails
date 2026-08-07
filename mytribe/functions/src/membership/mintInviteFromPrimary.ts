import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapCallable } from '../lib/wrapCallable';
import { loadMember, requirePrimary } from '../lib/memberGate';
import { sendFromTemplate } from '../lib/sendFromTemplate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { requireBaseUrl } from '../lib/requireBaseUrl';
import { INVITE_TTL_DAYS, SECONDARY_LABEL_MAX } from '../lib/schema';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * FLAGGED 2026-08-04, NOT DELETED: this callable appears to have no caller.
 *
 * It is exported from `index.ts` and deployed, and its own test exercises the
 * handler, but a repo-wide search finds no client that calls it: the kinfolk
 * portal's primary-invites-secondary flow goes through
 * `portal/addSecondaryContact.ts` (TribeProfile.tsx's InviteKinfolkCard), and
 * the admin path is `admin/mintInvite.ts`. It is the older and stricter of the
 * two primary-side mints (`loadMember` + `requirePrimary` before it writes
 * anything) and it sends three emails the newer path does not, so if the two
 * are ever reconciled this is the one to reconcile TOWARDS. Left deployed and
 * unchanged: an unreferenced invite mint is a thing to report, not to remove.
 */
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
  permissions: PermSchema,
});

function sanitizeLabel(s: string): string {
  return s.replace(/[<>{} -]/g, '').trim().slice(0, SECONDARY_LABEL_MAX) || 'Folk';
}

export async function mintInviteFromPrimaryHandler(req: CallableRequest<unknown>): Promise<{ inviteId: string }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const args = Args.parse(req.data);
  // Fail loud before any Firestore write, and before the authz check below —
  // matching createShareLink's guard-before-authz shape. See requireBaseUrl
  // for the full rationale. AUNTIE_OS_REVIEW_BASE_URL is only guarded when
  // this run will actually use it (AUNTIE_NOTIFY_EMAIL set): the invite doc,
  // and the invite.secondary mail, already exist by the point the
  // auntie-notify template is sent below (it needs the invite id), so this
  // check has to run up here, ahead of them, rather than at its own point of
  // use.
  const claimBaseUrl = requireBaseUrl('CLAIM_LINK_BASE_URL');
  const auntieNotifyEmail = process.env.AUNTIE_NOTIFY_EMAIL;
  const auntieReviewBaseUrl = auntieNotifyEmail ? requireBaseUrl('AUNTIE_OS_REVIEW_BASE_URL') : undefined;
  const member = await loadMember(args.familyId, req.auth.uid);
  requirePrimary(member);
  const proposedPermissions = { ...args.permissions, kintales_only: true };
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000);
  const ref = await db().collection('inviteRequests').add({
    tribeId: args.familyId,
    primaryUid: req.auth.uid,
    invitedEmail: args.invitedEmail.toLowerCase(),
    secondaryLabel: sanitizeLabel(args.secondaryLabel),
    proposedPermissions,
    proposedRole: 'SECONDARY',
    status: 'PENDING',
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });
  // Send emails (handled inline; trigger version is alternative)
  const claimUrl = `${claimBaseUrl}?invite=${ref.id}`;
  await sendFromTemplate('invite.secondary', args.invitedEmail, {
    primaryDisplayName: req.auth.token?.name ?? 'Your Kin Parent',
    secondaryDisplayName: args.invitedEmail,
    secondaryLabel: sanitizeLabel(args.secondaryLabel),
    tribeName: args.familyId,
    claimUrl,
    expiresInDays: INVITE_TTL_DAYS,
  });
  if (auntieNotifyEmail) {
    await sendFromTemplate('invite.auntie-notify', auntieNotifyEmail, {
      primaryDisplayName: req.auth.token?.name ?? 'Kin Parent',
      invitedEmail: args.invitedEmail,
      secondaryLabel: sanitizeLabel(args.secondaryLabel),
      tribeName: args.familyId,
      permissionsCsv: Object.entries(proposedPermissions).filter(([, v]) => v).map(([k]) => k).join(','),
      auntieReviewUrl: `${auntieReviewBaseUrl}/invites/${ref.id}`,
    });
  }
  if (req.auth.token?.email) {
    await sendFromTemplate('invite.primary-receipt', req.auth.token.email, {
      invitedEmail: args.invitedEmail,
      secondaryLabel: sanitizeLabel(args.secondaryLabel),
      tribeName: args.familyId,
      expiresInDays: INVITE_TTL_DAYS,
    });
  }
  await ref.update({ status: 'EMAIL_SENT', sentToInviteeAt: FieldValue.serverTimestamp(), auntieNotifiedAt: FieldValue.serverTimestamp() });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MEMBERSHIP_INVITE_SENT,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: req.auth.uid,
    familyId: args.familyId,
    payload: { inviteId: ref.id, invitedEmail: args.invitedEmail, includesBillingFull: proposedPermissions.billing_full },
  });
  return { inviteId: ref.id };
}

export const mintInviteFromPrimary = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SMTP2GO_API_KEY', 'EMAIL_FROM', 'SENTRY_DSN'] },
  wrapCallable('mintInviteFromPrimary', mintInviteFromPrimaryHandler),
);
