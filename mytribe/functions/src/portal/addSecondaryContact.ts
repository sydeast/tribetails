import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPrimary } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';

const Args = z.object({
  kinfolkId: z.string().optional(),
  invitedEmail: z.string().email(),
  secondaryLabel: z.string().max(40).optional(),
  permissions: z.object({
    billing_full: z.boolean().default(false),
    messaging_direct: z.boolean().default(true),
    messaging_group: z.boolean().default(true),
    kin_edit: z.boolean().default(false),
    kintales_only: z.boolean().default(true),
    home_access: z.boolean().default(false),
  }).partial().default({}),
});

const INVITE_TTL_DAYS = 14;

/**
 * MyTribe-flavored secondary contact invite.
 *
 * Auth model: caller must be in `clients/{uid}.kinfolkIds`. Creates an
 * inviteRequest doc that AuntieOS' `acceptInvite` Function will resolve.
 *
 * NOTE: existing `mintInviteFromPrimary` requires `families/{fid}/members/{uid}`
 * with role=PRIMARY, that membership tree is sparsely populated for portal
 * users. This wrapper sidesteps it and uses the kinfolk-uid auth model.
 */
export async function addSecondaryContactHandler(req: CallableRequest<unknown>): Promise<{ inviteId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  const firestore = db();
  const clientSnap = await firestore.collection('clients').doc(uid).get();
  const clientData = clientSnap.data() ?? {};
  // Was a hard clients/{uid}.kinfolkIds check with no staff path: an operator
  // got permission-denied here even though requireKinfolkPrimary right below
  // already knew how to bypass staff. Same resolver the read side uses; a
  // cross-tenant resolution is audit-logged inside it.
  const { kinfolkId } = await resolveKinfolkAccess(
    uid,
    args.kinfolkId,
    req.auth?.token?.admin === true,
    'addSecondaryContact',
  );

  // WARNING-19: minting a secondary invite (especially one carrying billing_full)
  // is a PRIMARY-only privilege. resolveKinfolkAccess above only proves the
  // caller belongs to the family (or is staff) — a restricted SECONDARY also
  // passes it. Gate on the member doc so a secondary cannot escalate by
  // minting further invites.
  // requireKinfolkPrimary mirrors mintInviteFromPrimary's loadMember+requirePrimary:
  // operator bypasses, legacy single-primary (no member doc) falls back to allow,
  // an ACTIVE non-PRIMARY member is denied. Matches mintInviteFromPrimary.ts:33-37.
  await requireKinfolkPrimary(uid, kinfolkId, req.auth?.token?.admin === true, 'addSecondaryContact');

  // Reject self-invites: caller cannot add their own email as the secondary.
  const lowerInvited = args.invitedEmail.toLowerCase();
  const callerEmail = ((req.auth?.token as { email?: string } | undefined)?.email ??
    (typeof clientData.email === 'string' ? (clientData.email as string) : null))?.toLowerCase();
  if (callerEmail && callerEmail === lowerInvited) {
    throw new HttpsError('failed-precondition', 'You cannot invite yourself.');
  }

  // S7-BLOCKER-2 dedupe: a cold-started first call can outlive the portal's
  // 20s callable timeout, so the kinfolk sees "failed" while the invite WAS
  // created — and their retry would mint a duplicate. Re-sending the same
  // email returns the live pending invite instead, making retries idempotent.
  const pendingSnap = await firestore
    .collection('inviteRequests')
    .where('tribeId', '==', kinfolkId)
    .where('invitedEmail', '==', lowerInvited)
    .where('status', '==', 'PENDING')
    .limit(1)
    .get();
  const existing = pendingSnap.docs[0];
  if (existing) {
    const existingExpiry = (existing.data() as { expiresAt?: { toMillis?: () => number } }).expiresAt;
    const stillLive =
      typeof existingExpiry?.toMillis !== 'function' || existingExpiry.toMillis() > Date.now();
    if (stillLive) {
      logEvent({
        severity: 'info',
        function: 'addSecondaryContact',
        event: 'portal.invite.deduped',
        uid,
        extra: { kinfolkId, inviteId: existing.id, invitedEmail: lowerInvited },
      });
      return { inviteId: existing.id };
    }
  }

  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000);
  const ref = await firestore.collection('inviteRequests').add({
    tribeId: kinfolkId,
    primaryUid: uid,
    invitedEmail: args.invitedEmail.toLowerCase(),
    secondaryLabel: (args.secondaryLabel ?? 'Folk').replace(/[<>{} -]/g, '').trim().slice(0, 40) || 'Folk',
    proposedPermissions: {
      billing_full: args.permissions.billing_full ?? false,
      messaging_direct: args.permissions.messaging_direct ?? true,
      messaging_group: args.permissions.messaging_group ?? true,
      kin_edit: args.permissions.kin_edit ?? false,
      kintales_only: args.permissions.kintales_only ?? true,
      home_access: args.permissions.home_access ?? false,
    },
    proposedRole: 'SECONDARY',
    requiresAuntieAck: !!args.permissions.billing_full,
    status: 'PENDING',
    source: 'mytribe-portal',
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });

  logEvent({
    severity: 'info',
    function: 'addSecondaryContact',
    event: 'portal.invite.minted',
    uid,
    extra: { kinfolkId, inviteId: ref.id, invitedEmail: args.invitedEmail.toLowerCase() },
  });
  return { inviteId: ref.id };
}

export const addSecondaryContact = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] , minInstances: 1 },
  wrapCallable('addSecondaryContact', addSecondaryContactHandler),
);
