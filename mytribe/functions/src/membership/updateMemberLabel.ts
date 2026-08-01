import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapCallable } from '../lib/wrapCallable';
import { loadMember, requirePrimary } from '../lib/memberGate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { SECONDARY_LABEL_MAX } from '../lib/schema';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  familyId: z.string().min(1),
  targetUid: z.string().min(1),
  secondaryLabel: z.string().max(SECONDARY_LABEL_MAX),
});

export async function updateMemberLabelHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const args = Args.parse(req.data);
  const caller = await loadMember(args.familyId, req.auth.uid);
  requirePrimary(caller);
  const sanitized = args.secondaryLabel.replace(/[<>{} -]/g, '').trim().slice(0, SECONDARY_LABEL_MAX) || 'Folk';
  await db().doc(`families/${args.familyId}/members/${args.targetUid}`).update({
    secondaryLabel: sanitized,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MEMBERSHIP_SECONDARY_LABEL_CHANGED,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: req.auth.uid,
    targetUid: args.targetUid,
    familyId: args.familyId,
    payload: { secondaryLabel: sanitized },
  });
  return { ok: true };
}

export const updateMemberLabel = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('updateMemberLabel', updateMemberLabelHandler),
);
