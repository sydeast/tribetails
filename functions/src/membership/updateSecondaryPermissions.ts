import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapCallable } from '../lib/wrapCallable';
import { loadMember, requirePrimary } from '../lib/memberGate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  familyId: z.string().min(1),
  targetUid: z.string().min(1),
  permissions: z.object({
    messaging_direct: z.boolean().optional(),
    messaging_group: z.boolean().optional(),
    kin_edit: z.boolean().optional(),
    home_access: z.boolean().optional(),
  }),
});

export async function updateSecondaryPermissionsHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const args = Args.parse(req.data);
  const caller = await loadMember(args.familyId, req.auth.uid);
  requirePrimary(caller);
  const target = await loadMember(args.familyId, args.targetUid);
  if (target.role !== 'SECONDARY') throw new HttpsError('failed-precondition', 'target not SECONDARY');
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  for (const [k, v] of Object.entries(args.permissions)) {
    updates[`permissions.${k}`] = v;
  }
  await db().doc(`families/${args.familyId}/members/${args.targetUid}`).update(updates);
  for (const [perm, val] of Object.entries(args.permissions)) {
    await writeAuditEntry({
      event: val ? AUDIT_EVENTS.PERM_GRANTED : AUDIT_EVENTS.PERM_REVOKED,
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: req.auth.uid,
      targetUid: args.targetUid,
      familyId: args.familyId,
      payload: { perm, value: val },
    });
  }
  return { ok: true };
}

export const updateSecondaryPermissions = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('updateSecondaryPermissions', updateSecondaryPermissionsHandler),
);
