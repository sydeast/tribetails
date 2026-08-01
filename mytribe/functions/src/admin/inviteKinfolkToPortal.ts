import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { sendFromTemplate } from '../lib/sendFromTemplate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { FULL_PERMISSIONS, INVITE_TTL_DAYS } from '../lib/schema';
import { TRIBETAILS_CORS } from '../lib/cors';
import { logEvent } from '../lib/logger';

/**
 * #14 (2026-06-08): invite an EXISTING kinfolk to the kinfolk portal.
 *
 * The operator creates a kinfolk in AuntieOS, then needs to send that kinfolk
 * their portal access. Unlike provisionTribe (which creates a brand-new family)
 * or mintInvite (which invites a SECONDARY co-parent), this targets an existing
 * `kinfolk/{kinfolkId}` record: it resolves the kinfolk's email, ensures the
 * MyTribe `families/{kinfolkId}` envelope exists, and sends a PRIMARY claim
 * invite. The AuntieOS kinfolk doc id IS the MyTribe family id (requestBooking
 * writes `families/${kinfolkId}/bookings`), so the two are the same tenant.
 *
 * Idempotent + safe for a "invite all kinfolk" sweep:
 *   - status 'no_email'       -> the kinfolk has no email on file (skip).
 *   - status 'already_active' -> the household already has a claimed PRIMARY (skip).
 *   - status 'sent'           -> a fresh invite email went out.
 */
const Args = z.object({
  kinfolkId: z.string().min(1).max(200),
});

export interface InviteKinfolkResult {
  kinfolkId: string;
  status: 'sent' | 'already_active' | 'no_email';
  inviteId?: string;
}

export async function inviteKinfolkToPortalHandler(
  req: CallableRequest<unknown>,
): Promise<InviteKinfolkResult> {
  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'inviteKinfolkToPortal validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const kinfolkId = args.kinfolkId;
  const kinfolkSnap = await db().collection('kinfolk').doc(kinfolkId).get();
  if (!kinfolkSnap.exists) {
    throw new HttpsError('not-found', `Kinfolk '${kinfolkId}' not found.`);
  }
  const k = kinfolkSnap.data() as Record<string, unknown>;
  const email = typeof k.email === 'string' ? k.email.trim() : '';
  if (!email) {
    return { kinfolkId, status: 'no_email' };
  }
  const first = typeof k.firstName === 'string' ? k.firstName : '';
  const last = typeof k.lastName === 'string' ? k.lastName : '';
  const householdName = `${first} ${last}`.trim() || email;

  // Skip households that already have a claimed PRIMARY member (don't re-spam).
  const activePrimary = await db()
    .collection(`families/${kinfolkId}/members`)
    .where('role', '==', 'PRIMARY')
    .where('status', '==', 'ACTIVE')
    .limit(1)
    .get();
  if (activePrimary.docs.length > 0) {
    return { kinfolkId, status: 'already_active' };
  }

  // Ensure the MyTribe family envelope exists so the claim (acceptInvite) lands.
  const familyRef = db().doc(`families/${kinfolkId}`);
  const familySnap = await familyRef.get();
  if (!familySnap.exists) {
    await familyRef.set({
      displayName: householdName,
      primaryUid: '',
      themeConfigRef: `families/${kinfolkId}/themeConfig/active`,
      flags: { tribePinSet: false, tribePinChangePending: false, unverified: false },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000);
  const inviteRef = await db().collection('inviteRequests').add({
    tribeId: kinfolkId,
    primaryUid: '',
    invitedEmail: email.toLowerCase(),
    proposedRole: 'PRIMARY',
    proposedPermissions: FULL_PERMISSIONS,
    requiresAuntieAck: false,
    status: 'PENDING',
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });

  await sendFromTemplate('invite.primary', email, {
    primaryDisplayName: householdName,
    tribeName: householdName,
    claimUrl: `${process.env.CLAIM_LINK_BASE_URL}?invite=${inviteRef.id}`,
    expiresInDays: INVITE_TTL_DAYS,
  });
  await inviteRef.update({ status: 'EMAIL_SENT', sentToInviteeAt: FieldValue.serverTimestamp() });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MEMBERSHIP_INVITE_SENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: req.auth!.uid,
    familyId: kinfolkId,
    payload: { inviteId: inviteRef.id, invitedEmail: email, role: 'PRIMARY', source: 'inviteKinfolkToPortal' },
  });

  logEvent({
    severity: 'info', function: 'inviteKinfolkToPortal', event: 'portal.invite.sent',
    uid: req.auth!.uid, extra: { kinfolkId, inviteId: inviteRef.id },
  });

  return { kinfolkId, status: 'sent', inviteId: inviteRef.id };
}

export const inviteKinfolkToPortal = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SMTP2GO_API_KEY', 'EMAIL_FROM', 'SENTRY_DSN'] },
  wrapAdminCallable('inviteKinfolkToPortal', inviteKinfolkToPortalHandler),
);
