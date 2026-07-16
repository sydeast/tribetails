import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapCallable } from '../lib/wrapCallable';
import { loadMember } from '../lib/memberGate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({ shareId: z.string().min(1) });

export async function revokeShareLinkHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const { shareId } = Args.parse(req.data);
  const ref = db().doc(`sharedKinTales/${shareId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'share not found');
  const data = snap.data() as { tribeId: string; createdBy: string };
  const caller = await loadMember(data.tribeId, req.auth.uid);
  if (caller.role !== 'PRIMARY' && data.createdBy !== req.auth.uid) {
    throw new HttpsError('permission-denied', 'permission-denied');
  }
  await ref.update({ revoked: true, revokedAt: FieldValue.serverTimestamp() });
  await writeAuditEntry({
    event: AUDIT_EVENTS.CONTENT_SHARE_LINK_REVOKED,
    severity: 'info',
    actorRole: caller.role === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY',
    actorUid: req.auth.uid,
    familyId: data.tribeId,
    payload: { shareId },
  });
  return { ok: true };
}

export const revokeShareLink = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('revokeShareLink', revokeShareLinkHandler),
);
