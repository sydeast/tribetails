import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { auth, db } from '../lib/firestoreAdmin';
import { HttpsError } from 'firebase-functions/v2/https';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { enqueueNotification } from '../notifications/dispatcher';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Migrated from sotu-hosting/functions/index.js setKinfolkClaim.
 *
 * Links a MyTribe Firebase Auth user to a kinfolk record:
 *   1. Sets custom claims `{ role: 'kinfolk', kinfolkId }` on the target uid.
 *   2. Writes the uid back onto `kinfolk/{kinfolkId}.uid` so Firestore rules
 *      and FCM targeting can resolve by uid.
 *
 * Auth: MyTribe operator allowlist (AUNTIE_OPERATOR_UIDS env).
 */
const Args = z.object({
  uid: z.string().min(1),
  kinfolkId: z.string().min(1),
});

export async function setKinfolkClaimHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; uid: string; kinfolkId: string }> {
  const args = Args.parse(req.data);

  const kinfolkRef = db().collection('kinfolk').doc(args.kinfolkId);
  const snap = await kinfolkRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `kinfolk/${args.kinfolkId} does not exist.`);
  }

  // WARNING-22: guard against re-linking a uid that is already bound to a
  // DIFFERENT kinfolk record. Without this, calling setKinfolkClaim with the
  // wrong kinfolkId silently repoints the user's claim and leaves a stale
  // `uid` on the old kinfolk doc (rules/FCM would resolve two kinfolk to one uid).
  const existingLinks = await db()
    .collection('kinfolk')
    .where('uid', '==', args.uid)
    .get();
  const conflict = existingLinks.docs.find((d) => d.id !== args.kinfolkId);
  if (conflict) {
    throw new HttpsError(
      'failed-precondition',
      `uid ${args.uid} is already linked to kinfolk/${conflict.id}; revoke that link first.`,
    );
  }

  // WARNING-22: MERGE onto existing custom claims instead of replacing the whole
  // object. setCustomUserClaims overwrites ALL claims, so a fresh
  // { role, kinfolkId } would wipe an operator/admin claim on this uid.
  const existing = (await auth().getUser(args.uid)).customClaims ?? {};
  await auth().setCustomUserClaims(args.uid, {
    ...existing,
    role: 'kinfolk',
    kinfolkId: args.kinfolkId,
  });

  await kinfolkRef.update({
    uid: args.uid,
    myTribeLinkedAt: FieldValue.serverTimestamp(),
  });

  logEvent({
    severity: 'info',
    function: 'setKinfolkClaim',
    event: 'admin.kinfolk.linked',
    uid: args.uid,
    extra: { kinfolkId: args.kinfolkId, actorUid: req.auth?.uid },
  });

  try {
    await enqueueNotification({
      key: 'account.welcome.business',
      recipientUid: args.uid,
      data: { kinfolkId: args.kinfolkId, kinfolkUid: args.uid, actorUid: req.auth?.uid ?? null },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'setKinfolkClaim',
      event: 'notification.dispatch.failed',
      extra: { kinfolkId: args.kinfolkId, key: 'account.welcome.business', err: (err as Error)?.message },
    });
  }

  return { ok: true, uid: args.uid, kinfolkId: args.kinfolkId };
}

export const setKinfolkClaim = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapAdminCallable('setKinfolkClaim', setKinfolkClaimHandler),
);
