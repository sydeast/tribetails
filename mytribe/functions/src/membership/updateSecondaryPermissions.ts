import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapCallable } from '../lib/wrapCallable';
import { loadMember, requirePrimary } from '../lib/memberGate';
import { isStaff } from '../lib/staffGate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { logEvent } from '../lib/logger';
import type { ActorRole } from '../lib/schema';

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
  const uid = req.auth.uid;
  const args = Args.parse(req.data);

  // Was a hard families/{familyId}/members/{uid} lookup with no staff path:
  // an operator has no member doc for ANY family by design (memberGate.ts),
  // so loadMember always threw permission-denied before an operator ever
  // reached requirePrimary. isStaff is the one gate every portal check goes
  // through (RULING O-6); NOT requireKinfolkPrimary, whose legacy
  // missing-member-doc fallback assumes an earlier clients/{uid}.kinfolkIds
  // check already ran, which this callable has never had, so swapping to it
  // wholesale would let ANY stranger with no member doc through as if they
  // were a legacy PRIMARY. The non-staff path below is untouched.
  const hasAdminClaim = req.auth?.token?.admin === true;
  const isOperator = isStaff(uid, hasAdminClaim, 'updateSecondaryPermissions');
  if (!isOperator) {
    const caller = await loadMember(args.familyId, uid);
    requirePrimary(caller);
  }

  const target = await loadMember(args.familyId, args.targetUid);
  if (target.role !== 'SECONDARY') throw new HttpsError('failed-precondition', 'target not SECONDARY');
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  for (const [k, v] of Object.entries(args.permissions)) {
    updates[`permissions.${k}`] = v;
  }
  await db().doc(`families/${args.familyId}/members/${args.targetUid}`).update(updates);

  if (isOperator) {
    // Matches resolveKinfolkAccess's read-side pattern: an operator has no
    // "own" household to compare against, so every staff write here is
    // audit-logged as cross-tenant access.
    await writeAuditEntry({
      event: AUDIT_EVENTS.OPERATOR_CROSSTENANT_ACCESS,
      severity: 'info',
      actorRole: 'AUNTIE',
      actorUid: uid,
      targetUid: args.familyId,
      payload: { function: 'updateSecondaryPermissions', kinfolkId: args.familyId },
    }).catch((err) => {
      logEvent({
        severity: 'warn', function: 'updateSecondaryPermissions', event: 'audit.write.failed',
        uid, errorMessage: (err as Error)?.message,
      });
    });
  }

  const actorRole: ActorRole = isOperator ? 'AUNTIE' : 'PRIMARY';
  for (const [perm, val] of Object.entries(args.permissions)) {
    await writeAuditEntry({
      event: val ? AUDIT_EVENTS.PERM_GRANTED : AUDIT_EVENTS.PERM_REVOKED,
      severity: 'info',
      actorRole,
      actorUid: uid,
      targetUid: args.targetUid,
      familyId: args.familyId,
      payload: { perm, value: val },
    });
  }
  return { ok: true };
}

export const updateSecondaryPermissions = onCall(
  // AUNTIE_OPERATOR_UIDS is required because isStaff reads it. Binding it is
  // not optional: without it the allowlist arm evaluates false silently, and
  // an operator not yet holding the admin claim gets permission-denied with
  // no indication why.
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('updateSecondaryPermissions', updateSecondaryPermissionsHandler),
);
