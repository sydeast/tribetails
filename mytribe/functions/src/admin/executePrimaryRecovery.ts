import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { sendFromTemplate } from '../lib/sendFromTemplate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { requireBaseUrl } from '../lib/requireBaseUrl';
import {
  listRecoveryCandidates,
  matchRecoveryCandidate,
  normalizeRecoveryEmail,
  recoveryRejectionMessage,
} from '../lib/recoveryCandidates';
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
  // Fail loud before any Firestore write — see requireBaseUrl for the full
  // rationale. This is an account-recovery link: a broken one here locks the
  // household out and reports success while doing it.
  const claimBaseUrl = requireBaseUrl('CLAIM_LINK_BASE_URL');

  // #378: the destination address is checked BEFORE anything is written, and
  // the old PRIMARY's suspension has moved below this gate. Suspension used to
  // be the first thing that happened, so a recovery that failed for any reason
  // afterwards still left the household's primary locked out with no claim link
  // in anyone's inbox. A refused recovery must now cost the household nothing.
  //
  // The gate itself: the address must belong to a verified Auth account that is
  // already a member of this household. See lib/recoveryCandidates.ts for what
  // counts and why. There is deliberately no flag, override, or fallback that
  // restores the old behaviour of mailing a live claim link to a typed address.
  const candidates = await listRecoveryCandidates(args.familyId, { excludeUid: args.oldUid });
  const target = matchRecoveryCandidate(candidates, args.newEmail);
  if (target === null) {
    // Recorded, not merely refused. A blocked attempt is exactly the signal
    // worth reviewing — an operator typo, or a session being used to try — so
    // it carries the same 'critical' severity as a successful recovery and
    // differs only in status.
    await writeAuditEntry({
      status: 'FAILURE',
      event: AUDIT_EVENTS.AUTH_RECOVERY_TRIGGERED,
      severity: 'critical',
      actorRole: 'AUNTIE', actorUid: req.auth!.uid,
      targetUid: args.oldUid,
      familyId: args.familyId,
      description: 'Primary recovery refused: the requested address is not a verified member of this household.',
      payload: {
        newEmail: normalizeRecoveryEmail(args.newEmail),
        recoveryRequestId: args.recoveryRequestId,
        reason: 'not_a_verified_household_member',
        eligibleCount: candidates.length,
      },
    });
    throw new HttpsError('failed-precondition', recoveryRejectionMessage(args.newEmail, candidates));
  }

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
    invitedEmail: target.email,
    proposedRole: 'PRIMARY',
    proposedPermissions: FULL_PERMISSIONS,
    status: 'EMAIL_SENT',
    createdAt: FieldValue.serverTimestamp(),
    sentToInviteeAt: FieldValue.serverTimestamp(),
    expiresAt,
  });
  // The address on the Auth account, not the one that arrived in the request
  // body. They can now differ only by case or surrounding whitespace, but
  // sending the resolved one keeps the mail and the invite doc pointed at the
  // same verified inbox rather than at two spellings of it.
  await sendFromTemplate('recovery.completed', target.email, {
    tribeName: args.familyId,
    claimUrl: `${claimBaseUrl}?invite=${inviteRef.id}`,
  });
  await writeAuditEntry({
    // This IS the success path (the invite was minted and sent above); 'critical'
    // marks it for elevated review, not a failed action. Status is explicit
    // because the old severity-based default read 'critical' as FAILURE and
    // mislabeled every successful recovery (see A4 audit).
    status: 'SUCCESS',
    event: AUDIT_EVENTS.AUTH_RECOVERY_TRIGGERED,
    severity: 'critical',
    actorRole: 'AUNTIE', actorUid: req.auth!.uid,
    targetUid: args.oldUid,
    familyId: args.familyId,
    payload: {
      newEmail: target.email,
      recoveryRequestId: args.recoveryRequestId,
      newPrimaryUid: target.uid,
    },
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
