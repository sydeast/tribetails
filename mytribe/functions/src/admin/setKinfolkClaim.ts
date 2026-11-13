import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { auth, db } from '../lib/firestoreAdmin';
import { HttpsError } from 'firebase-functions/v2/https';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import {
  decidePrimaryLink,
  primaryLinkRefusalText,
  primaryMemberRecord,
  readPrimaryLinkFacts,
} from '../lib/householdMember';

/**
 * Migrated from sotu-hosting/functions/index.js setKinfolkClaim.
 *
 * Links a MyTribe Firebase Auth user to a kinfolk record:
 *   1. Sets custom claims `{ role: 'kinfolk', kinfolkId }` on the target uid.
 *   2. Writes the uid back onto `kinfolk/{kinfolkId}.uid` so Firestore rules
 *      and FCM targeting can resolve by uid.
 *   0. First (#2096): the household's ACTIVE PRIMARY member record and the
 *      `clients/{uid}.kinfolkIds` listing, exactly as `acceptInvite` writes
 *      them, or a refusal when the login must not be linked (a staff login,
 *      a removed member, a household that has another PRIMARY).
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

  // #2096: link the login the way accepting an invite does, or not at all.
  // This used to set the claim and `kinfolk.uid` and write no member record,
  // so since #1840 the household would get no notices, and the Members panel
  // showed nobody. The same decision the test-login scripts and the backfill
  // use (lib/householdMember.ts): a staff login is refused (#1840), a removed
  // member is not added back, a household with another PRIMARY keeps it.
  const facts = await readPrimaryLinkFacts({ db: db(), auth: auth() }, args.kinfolkId, args.uid);
  const decision = decidePrimaryLink(args.uid, facts);
  if (decision.action === 'refuse') {
    logEvent({
      severity: 'info',
      function: 'setKinfolkClaim',
      event: 'admin.kinfolk.link.refused',
      uid: args.uid,
      familyId: args.kinfolkId,
      extra: { why: decision.why, actorUid: req.auth?.uid },
    });
    throw new HttpsError('failed-precondition', `This login was not linked: ${primaryLinkRefusalText(decision.why)}.`);
  }

  // The member record and the client listing together, as acceptInvite writes
  // them in one transaction, and BEFORE the claim: a link that fails here has
  // granted nothing. `create` (not `set`) for the member: a record that
  // appeared since the read above is left as it is and the link fails loudly.
  await db().runTransaction(async (tx) => {
    if (decision.action === 'create_primary') {
      tx.create(
        db().doc(`families/${args.kinfolkId}/members/${args.uid}`),
        primaryMemberRecord(args.uid, facts.email, FieldValue.serverTimestamp()),
      );
    }
    tx.set(
      db().doc(`clients/${args.uid}`),
      { kinfolkIds: FieldValue.arrayUnion(args.kinfolkId), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  });

  // WARNING-22: MERGE onto existing custom claims instead of replacing the whole
  // object. setCustomUserClaims overwrites ALL claims, so a fresh
  // { role, kinfolkId } would wipe another claim on this uid.
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

  // No notification is sent from here. This used to enqueue
  // `account.welcome.business`, which the operator retired on 2026-08-18: they
  // do not want to be told when an invited kinfolk finishes account setup. The
  // catalog row is gone (see RETIRED_NOTIFICATION_KEYS in notifications/catalog.ts),
  // so an enqueue here would now throw `unknown key` rather than send anything.
  return { ok: true, uid: args.uid, kinfolkId: args.kinfolkId };
}

export const setKinfolkClaim = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapAdminCallable('setKinfolkClaim', setKinfolkClaimHandler),
);
