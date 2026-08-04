import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import type { MemberDoc } from '../lib/schema';

// RULING (2026-08-04): "admin can edit permissions but not like primary's
// access to full billing, home access, kin edit, etc."
//
// A PRIMARY's entitlements come from the role, not from these flags.
// `requirePerm` in memberGate.ts returns before it reads `permissions` when
// `role === 'PRIMARY'`, and `hasKinfolkPerm` answers true the same way, so
// every write this callable ever made against a PRIMARY target moved a field
// that no enforcement path consults. The damage was not the write, it was the
// story around it: the audit log recorded PERM_BILLING_REVOKED for a
// revocation that did not happen, and the roster then rendered the household's
// own primary as someone who had lost billing.
//
// The sibling `updateSecondaryPermissions` has carried this guard since it was
// written (`target.role !== 'SECONDARY'`). This one never did, which made the
// admin path the only one that could write permission flags onto a PRIMARY.
// Admin editing a SECONDARY's permissions is unchanged and stays legitimate.
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
  // Read the role off the snapshot already in hand rather than `loadMember`:
  // the message and code for a missing member doc are documented in
  // CALLABLE_CONTRACT.md as `not-found`, and loadMember answers
  // permission-denied. Same guard, same wording as updateSecondaryPermissions.
  const target = snap.data() as MemberDoc;
  if (target.role !== 'SECONDARY') throw new HttpsError('failed-precondition', 'target not SECONDARY');
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
