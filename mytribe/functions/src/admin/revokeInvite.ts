import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({ inviteId: z.string().min(1) });

export async function revokeInviteHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  const { inviteId } = Args.parse(req.data);
  const ref = db().doc(`inviteRequests/${inviteId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'invite not found');
  await ref.update({ status: 'REVOKED', revokedAt: FieldValue.serverTimestamp() });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MEMBERSHIP_INVITE_REVOKED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: req.auth!.uid,
    familyId: (snap.data() as { tribeId: string }).tribeId,
    payload: { inviteId },
  });
  return { ok: true };
}

export const revokeInvite = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('revokeInvite', revokeInviteHandler),
);
