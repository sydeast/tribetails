import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db, auth } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({ familyId: z.string().min(1), targetUid: z.string().min(1) });

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
  await auth().revokeRefreshTokens(args.targetUid);
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
