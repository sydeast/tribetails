import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  familyId: z.string().min(1),
  targetUid: z.string().min(1),
  permissions: z.object({
    billing_full: z.boolean().optional(),
    messaging_direct: z.boolean().optional(),
    messaging_group: z.boolean().optional(),
    kin_edit: z.boolean().optional(),
    home_access: z.boolean().optional(),
  }),
});

export async function setMemberPermissionsHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  const args = Args.parse(req.data);
  const ref = db().doc(`families/${args.familyId}/members/${args.targetUid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'member not found');
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  for (const [k, v] of Object.entries(args.permissions)) updates[`permissions.${k}`] = v;
  await ref.update(updates);
  for (const [perm, val] of Object.entries(args.permissions)) {
    const event = perm === 'billing_full'
      ? (val ? AUDIT_EVENTS.PERM_BILLING_GRANTED : AUDIT_EVENTS.PERM_BILLING_REVOKED)
      : (val ? AUDIT_EVENTS.PERM_GRANTED : AUDIT_EVENTS.PERM_REVOKED);
    await writeAuditEntry({
      status: 'SUCCESS',
      event,
      severity: perm === 'billing_full' ? 'warn' : 'info',
      actorRole: 'AUNTIE',
      actorUid: req.auth!.uid,
      targetUid: args.targetUid,
      familyId: args.familyId,
      payload: { perm, value: val },
    });
  }
  return { ok: true };
}

export const setMemberPermissions = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('setMemberPermissions', setMemberPermissionsHandler),
);
