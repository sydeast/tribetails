import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db, auth } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({ familyId: z.string().min(1), targetUid: z.string().min(1) });

/**
 * A removed secondary kinfolk's person record goes back to 'NONE' (#1018,
 * item 1). `families/{familyId}/secondaryKinfolk` is keyed by `personId`, not
 * `memberUid`, so the match is a query; a primary or an already-'NONE'/
 * 'INVITED' person has no matching row, and that is not an error, it just
 * means there is nothing to reset. `memberUid` and `inviteId` are cleared too:
 * a 'NONE' record still pointing at a suspended uid or a spent invite would be
 * a lie to every client reading it, and `acceptInvite` mints a fresh
 * `memberUid` on the next invite regardless.
 */
async function resetSecondaryKinfolkAccess(familyId: string, targetUid: string, actorUid: string): Promise<void> {
  const snap = await db()
    .collection(`families/${familyId}/secondaryKinfolk`)
    .where('memberUid', '==', targetUid)
    .get();
  await Promise.all(
    snap.docs.map((d) =>
      d.ref.update({
        access: 'NONE',
        memberUid: null,
        inviteId: null,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: actorUid,
      }),
    ),
  );
}

export async function removeMemberHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  const args = Args.parse(req.data);
  const ref = db().doc(`families/${args.familyId}/members/${args.targetUid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'member not found');
  await ref.update({ status: 'SUSPENDED', updatedAt: FieldValue.serverTimestamp() });
  await db().doc(`clients/${args.targetUid}`).update({
    kinfolkIds: FieldValue.arrayRemove(args.familyId),
    updatedAt: FieldValue.serverTimestamp(),
  });
  // Security-critical: kills any live session before the (non-critical)
  // secondary-kinfolk reset below, so a failure in that reset never leaves a
  // suspended member holding working tokens.
  await auth().revokeRefreshTokens(args.targetUid);
  await resetSecondaryKinfolkAccess(args.familyId, args.targetUid, req.auth!.uid);
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MEMBERSHIP_MEMBER_REMOVED,
    severity: 'warn',
    actorRole: 'AUNTIE',
    actorUid: req.auth!.uid,
    targetUid: args.targetUid,
    familyId: args.familyId,
    payload: {},
  });
  return { ok: true };
}

export const removeMember = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('removeMember', removeMemberHandler),
);
