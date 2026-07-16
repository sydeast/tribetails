import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { auth, db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Migrated from sotu-hosting/functions/index.js revokeKinfolkClaim.
 *
 * Unlinks a MyTribe Firebase Auth user from a kinfolk record:
 *   1. Clears custom claims on the target uid.
 *   2. Blanks `kinfolk/{kinfolkId}.uid` and removes `myTribeLinkedAt`.
 *
 * Auth: MyTribe operator allowlist (AUNTIE_OPERATOR_UIDS env).
 */
const Args = z.object({
  uid: z.string().min(1),
  kinfolkId: z.string().min(1),
});

export async function revokeKinfolkClaimHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; uid: string; kinfolkId: string }> {
  const args = Args.parse(req.data);

  // WARNING-22: only strip the kinfolk-link claims (role + kinfolkId), preserving
  // any other claims (e.g. an operator/admin claim) on this uid. Replacing the
  // whole object with {} previously wiped every claim the user held.
  const existing = (await auth().getUser(args.uid)).customClaims ?? {};
  const { role, kinfolkId, ...rest } = existing as Record<string, unknown>;
  void role;
  void kinfolkId;
  await auth().setCustomUserClaims(args.uid, rest);

  await db().collection('kinfolk').doc(args.kinfolkId).update({
    uid: '',
    myTribeLinkedAt: FieldValue.delete(),
  });

  logEvent({
    severity: 'info',
    function: 'revokeKinfolkClaim',
    event: 'admin.kinfolk.unlinked',
    uid: args.uid,
    extra: { kinfolkId: args.kinfolkId, actorUid: req.auth?.uid },
  });

  return { ok: true, uid: args.uid, kinfolkId: args.kinfolkId };
}

export const revokeKinfolkClaim = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapAdminCallable('revokeKinfolkClaim', revokeKinfolkClaimHandler),
);
