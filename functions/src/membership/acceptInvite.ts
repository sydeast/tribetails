import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { logEvent } from '../lib/logger';
import { enqueueNotification } from '../notifications/dispatcher';
import { syncKinfolkClaim } from '../lib/kinfolkClaim';
import type { InviteRequestDoc } from '../lib/schema';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({ inviteId: z.string().min(1) });

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
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] , minInstances: 1 },
  wrapCallable('acceptInvite', acceptInviteHandler),
);
