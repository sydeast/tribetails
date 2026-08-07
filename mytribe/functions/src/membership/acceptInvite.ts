import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { enforceRateLimit } from '../lib/rateLimit';
import { sendFromTemplate } from '../lib/sendFromTemplate';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { requireBaseUrl } from '../lib/requireBaseUrl';
import { logEvent } from '../lib/logger';
import { enqueueNotification } from '../notifications/dispatcher';
import { syncKinfolkClaim } from '../lib/kinfolkClaim';
import type { InviteRequestDoc } from '../lib/schema';
import { TRIBETAILS_CORS } from '../lib/cors';
import { FULL_CPU } from '../lib/runtimeOptions';

const Args = z.object({ inviteId: z.string().min(1) });

/**
 * Mint a Firebase verification link for the invited address and mail it, so the
 * "verify first" refusal above hands the invitee the thing they need instead of
 * telling them to go find it.
 *
 * Deliberately NEVER throws. Its caller is already refusing the accept; a mail
 * failure must not turn an actionable `failed-precondition` into an opaque
 * `internal`, and the invite stays live either way. A caller who gets the
 * message but no mail can still verify through any normal Firebase route.
 *
 * Rate-limited per uid AND per address: this is the one place an unauthenticated
 * -adjacent caller can make us send mail on demand, and a retry loop on the
 * claim screen must not become a mail bomb aimed at the invited mailbox. Hitting
 * the limit suppresses the send silently. The refusal is unchanged, and the
 * earlier mail is already in that inbox.
 */
async function sendInviteVerificationEmail(
  uid: string,
  invitedEmail: string,
  inviteId: string,
): Promise<void> {
  try {
    // Guarded first, ahead of the rate limiting and the mail send: a
    // misconfigured CLAIM_LINK_BASE_URL must not spend the caller's rate
    // limit or mail a link reading "undefined?invite=<id>". This function is
    // deliberately documented to NEVER throw to its caller (see above), so
    // requireBaseUrl's HttpsError is absorbed by the catch below exactly
    // like any other send failure (dead SMTP key, rate limited, ...) rather
    // than propagated — the outer refusal in acceptInviteHandler is
    // unaffected either way.
    const claimBaseUrl = requireBaseUrl('CLAIM_LINK_BASE_URL');
    await enforceRateLimit('inviteVerifyEmail', uid, 5, 3600);
    await enforceRateLimit('inviteVerifyEmail', invitedEmail.toLowerCase(), 5, 3600);
    const verifyUrl = await getAuth().generateEmailVerificationLink(invitedEmail);
    await sendFromTemplate('invite.verify-email', invitedEmail, {
      invitedEmail,
      verifyUrl,
      claimUrl: `${claimBaseUrl}?invite=${inviteId}`,
    });
    logEvent({
      severity: 'info',
      function: 'acceptInvite',
      event: 'invite.verification.sent',
      uid,
      extra: { inviteId },
    });
  } catch (err) {
    // 'error', not 'warn': acceptInviteHandler still tells the caller "We
    // just emailed a verification link to that address" regardless of what
    // happens in here (the never-throw contract above). A dead SMTP key or a
    // rate limit is a transient version of that lie; an unset
    // CLAIM_LINK_BASE_URL is a standing one that fires on every unverified
    // accept until someone notices — 'warn' is too easy to let sit unread.
    logEvent({
      severity: 'error',
      function: 'acceptInvite',
      event: 'invite.verification.send.failed',
      uid,
      extra: { inviteId, err: (err as Error)?.message },
    });
  }
}

export async function acceptInviteHandler(req: CallableRequest<unknown>): Promise<{ familyId: string }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const { inviteId } = Args.parse(req.data);
  const tokenEmail = (req.auth.token as { email?: string }).email;
  const inviteRef = db().doc(`inviteRequests/${inviteId}`);
  const snap = await inviteRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'invite not found');
  const invite = snap.data() as InviteRequestDoc;
  if (invite.status === 'ACCEPTED') {
    // Idempotent only for the user who claimed it; anyone else holding the
    // link must not learn the tribeId.
    if (invite.acceptedUid === req.auth.uid) return { familyId: invite.tribeId };
    throw new HttpsError('failed-precondition', 'invite no longer valid');
  }
  if (invite.status === 'REVOKED' || invite.status === 'EXPIRED') {
    throw new HttpsError('failed-precondition', 'invite no longer valid');
  }
  if ((invite.expiresAt as unknown as { toMillis(): number }).toMillis() < Date.now()) {
    await inviteRef.update({ status: 'EXPIRED' });
    throw new HttpsError('failed-precondition', 'invite expired');
  }
  if (!tokenEmail || tokenEmail.toLowerCase() !== invite.invitedEmail.toLowerCase()) {
    throw new HttpsError('permission-denied', 'invite email mismatch');
  }
  // RULING: "secondary needs email verification as well."
  //
  // firestore.rules hardened exactly this branch months ago (WARNING-17, the
  // inviteRequests read rule) on the grounds that an unverified email is
  // attacker-controllable: anyone can sign up with any address and never prove
  // it. This callable then trusted the same unproven address to hand out
  // household membership, which is the larger grant of the two. The rule and the
  // callable now agree.
  //
  // This does NOT break the existing-account claim path, which is the flow B1
  // exists to unblock. Two populations reach here:
  //   * Brand-new invitees. `claimInviteSignup` mints the account with
  //     `emailVerified: true` (it delivered the link to that mailbox itself), so
  //     their very first token already passes and nothing changes for them.
  //   * Invitees who ALREADY have a Firebase account. That account may be an
  //     unverified email+password signup, and that is the case this branch is
  //     for. Rather than a bare permission-denied that leaves them stuck, we mint
  //     a verification link and mail it to the invited address, then tell them
  //     what to do. The invite is untouched and still live for its full TTL, so
  //     the same claim link works the moment they come back verified.
  if (req.auth.token.email_verified !== true) {
    await sendInviteVerificationEmail(req.auth.uid, invite.invitedEmail, inviteId);
    throw new HttpsError(
      'failed-precondition',
      `Verify ${invite.invitedEmail} before joining. We just emailed a verification link to that address. Open it, then come back to this invite link.`,
    );
  }
  const memberRef = db().doc(`families/${invite.tribeId}/members/${req.auth.uid}`);
  const clientRef = db().doc(`clients/${req.auth.uid}`);
  await db().runTransaction(async (tx) => {
    // WARNING-20 (TOCTOU): the status/expiry/email checks above ran against a
    // pre-transaction read. Two concurrent accepts (or a sequential second accept
    // that slipped in after the first) could both pass them and each write a
    // member doc / arrayUnion / flip the invite. Re-read INSIDE the tx and
    // re-assert the invite is still acceptable; throw failed-precondition if a
    // racing accept already consumed/voided it. The email/tribe were already
    // bound to this invite id, so only the consumable status + expiry can change.
    const fresh = await tx.get(inviteRef);
    if (!fresh.exists) throw new HttpsError('failed-precondition', 'invite no longer valid');
    const freshInvite = fresh.data() as InviteRequestDoc;
    if (
      freshInvite.status === 'ACCEPTED' ||
      freshInvite.status === 'REVOKED' ||
      freshInvite.status === 'EXPIRED'
    ) {
      throw new HttpsError('failed-precondition', 'invite no longer valid');
    }
    if ((freshInvite.expiresAt as unknown as { toMillis(): number }).toMillis() < Date.now()) {
      throw new HttpsError('failed-precondition', 'invite expired');
    }
    tx.set(memberRef, {
      uid: req.auth!.uid,
      displayName: tokenEmail,
      role: invite.proposedRole,
      secondaryLabel: invite.secondaryLabel ?? null,
      permissions: invite.proposedPermissions,
      status: 'ACTIVE',
      invitedAt: invite.createdAt,
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      clientRef,
      { kinfolkIds: FieldValue.arrayUnion(invite.tribeId), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    tx.update(inviteRef, {
      status: 'ACCEPTED',
      acceptedUid: req.auth!.uid,
    });
  });
  // O-37: stamp role/kinfolkId now, the same way setActiveTribe does, instead of
  // leaving it to onClientsWrite. The trigger fires whenever it fires, so a kinfolk
  // was a member seconds before their token could prove it — and every claim-gated
  // direct read (conversations/{kinfolkId}, kin_care_sessions/{id}/breadcrumbs) is
  // dark for that whole window. Best-effort: the tx above has already committed, so
  // throwing here would report "joining didn't finish" about work that finished. The
  // trigger remains the backstop, and the client re-checks its token on boot.
  try {
    const { kinfolkId } = await syncKinfolkClaim(req.auth.uid);
    logEvent({
      severity: 'info',
      function: 'acceptInvite',
      event: 'claim.synced',
      extra: { inviteId, kinfolkId },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'acceptInvite',
      event: 'claim.sync.failed',
      extra: { inviteId, uid: req.auth.uid, err: (err as Error)?.message },
    });
  }
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MEMBERSHIP_INVITE_ACCEPTED,
    severity: 'info',
    actorRole: invite.proposedRole === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY',
    actorUid: req.auth.uid,
    familyId: invite.tribeId,
    payload: { inviteId },
  });
  try {
    await enqueueNotification({
      key: 'account.welcome.kinfolk',
      recipientUid: req.auth.uid,
      data: {
        kinfolkId: invite.tribeId,
        invitedEmail: invite.invitedEmail,
        role: invite.proposedRole,
      },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'acceptInvite',
      event: 'notification.dispatch.failed',
      extra: { inviteId, key: 'account.welcome.kinfolk', err: (err as Error)?.message },
    });
  }
  // Run-4: "Kinfolk Accepted MyTribe Invite" (Business bucket). The business-facing
  // welcome/accept notification existed in the catalog but was never emitted; wire it
  // here so the operator is told when an invited kinfolk completes setup.
  // businessAdmins resolver -> no recipientUid needed.
  try {
    await enqueueNotification({
      key: 'account.welcome.business',
      data: {
        kinfolkId: invite.tribeId,
        invitedEmail: invite.invitedEmail,
        role: invite.proposedRole,
      },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'acceptInvite',
      event: 'notification.dispatch.failed',
      extra: { inviteId, key: 'account.welcome.business', err: (err as Error)?.message },
    });
  }
  return { familyId: invite.tribeId };
}

export const acceptInvite = onCall(
  // SMTP2GO_API_KEY + EMAIL_FROM are bound because the unverified-email branch
  // mails the invitee a verification link. Both are already created and already
  // bound to the other invite functions (mintInviteFromPrimary, mintInvite), so
  // this adds no new secret to create, only a new consumer of two existing ones.
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN', 'SMTP2GO_API_KEY', 'EMAIL_FROM'],
    minInstances: 1,
    // Kept at a full vCPU so the warm instance minInstances buys keeps 80-way
    // concurrency; below 1 vCPU Cloud Run pins concurrency to 1.
    ...FULL_CPU,
  },
  wrapCallable('acceptInvite', acceptInviteHandler),
);
