import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { sendFromTemplate } from '../lib/sendFromTemplate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { requireBaseUrl } from '../lib/requireBaseUrl';
import { FULL_PERMISSIONS, INVITE_TTL_DAYS } from '../lib/schema';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * The admin invite. It invites a household's PRIMARY, and nothing else.
 *
 * RULING (2026-08-04): "The PRIMARY kinfolk invites the secondary. The admin
 * does NOT. The admin's only invite is inviting the primary to the portal."
 *
 * This callable defaulted `proposedRole` to SECONDARY, so the ordinary admin
 * call minted the one invite an admin is not the one to send. The secondary
 * invite has its own reachable path and always did:
 * `portal/addSecondaryContact.ts`, called by the primary from the kinfolk
 * portal's InviteKinfolkCard.
 *
 * `proposedRole` survives as a literal rather than being dropped so that an
 * older client still sending `'SECONDARY'` gets `invalid-argument` and stops,
 * instead of being silently upgraded to minting a PRIMARY claim, which is the
 * larger grant of the two.
 *
 * `proposedPermissions` and `secondaryLabel` are gone from the schema. A
 * PRIMARY's entitlements are inherent to the role (`requirePerm` in
 * memberGate.ts returns early for PRIMARY without reading the flags), so a
 * per-invite permission set was a choice with no effect, and `acceptInvite`
 * copies `proposedPermissions` verbatim onto the member doc, which is how a
 * PRIMARY ended up on the roster carrying `billing_full: false`. The invite now
 * writes FULL_PERMISSIONS, exactly as `inviteKinfolkToPortal` does for the same
 * grant. Both fields are still accepted-and-ignored rather than rejected: this
 * is a non-strict z.object, so an APK that has not shipped yet keeps working.
 *
 * The sibling primary invite is `inviteKinfolkToPortal`, which resolves the
 * address off the `kinfolk` record and skips a household that already has an
 * ACTIVE primary. This one takes the address the operator types, for a
 * household whose record carries the wrong address or none.
 */
const Args = z.object({
  familyId: z.string().min(1),
  invitedEmail: z.string().email(),
  proposedRole: z.literal('PRIMARY').optional().default('PRIMARY'),
});

export async function mintInviteHandler(req: CallableRequest<unknown>): Promise<{ inviteId: string }> {
  const args = Args.parse(req.data);
  // Fail loud before any Firestore write — see requireBaseUrl for the full
  // rationale.
  const claimBaseUrl = requireBaseUrl('CLAIM_LINK_BASE_URL');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000);
  const ref = await db().collection('inviteRequests').add({
    tribeId: args.familyId,
    primaryUid: '',
    invitedEmail: args.invitedEmail.toLowerCase(),
    proposedPermissions: FULL_PERMISSIONS,
    proposedRole: 'PRIMARY',
    status: 'PENDING',
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });
  await sendFromTemplate('invite.primary', args.invitedEmail, {
    // The template greets `primaryDisplayName` and this callable has no
    // household record to read a name from, so it greets the address the
    // invite was sent to. It used to greet "Auntie", which addressed the
    // kinfolk by the name of the person mailing them.
    primaryDisplayName: args.invitedEmail,
    tribeName: args.familyId,
    claimUrl: `${claimBaseUrl}?invite=${ref.id}`,
    expiresInDays: INVITE_TTL_DAYS,
  });
  await ref.update({ status: 'EMAIL_SENT', sentToInviteeAt: FieldValue.serverTimestamp() });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MEMBERSHIP_INVITE_SENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: req.auth!.uid,
    familyId: args.familyId,
    payload: { inviteId: ref.id, invitedEmail: args.invitedEmail, role: 'PRIMARY' },
  });
  return { inviteId: ref.id };
}

export const mintInvite = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SMTP2GO_API_KEY', 'EMAIL_FROM', 'SENTRY_DSN'] },
  wrapAdminCallable('mintInvite', mintInviteHandler),
);
