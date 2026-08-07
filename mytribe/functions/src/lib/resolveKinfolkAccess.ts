import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';
import { isStaff } from './staffGate';
import { resolveNonStaffKinfolkId } from './resolveNonStaffKinfolkId';
import { logEvent } from './logger';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS } from './auditEvents';

export interface ResolvedKinfolkAccess {
  kinfolkId: string;
  isOperator: boolean;
}

/**
 * Resolves the kinfolkId a portal callable should operate on, given the caller
 * uid and the optional requested kinfolkId.
 *
 * Non-staff: delegated wholesale to `resolveNonStaffKinfolkId`, which is the
 * one place the own-household discriminator lives (empty ids, omitted-or-`''`
 * with one id, omitted-or-`''` with more than one, requested in/not in the
 * set). See that file for the per-case table and the PR28a/PR28b rationale.
 * It performs the same single `clients/{uid}` read this function used to do
 * inline, so a non-staff call still costs exactly one read.
 *
 * Staff (RULING O-6: `admin` claim, or the AUNTIE_OPERATOR_UIDS transition
 * fallback — see `isStaff`):
 *   - any requested kinfolkId   -> ok, IF it exists (existence check —
 *     RULING O-6 hardening 1); a cross-tenant resolution (requested id not
 *     in the caller's own kinfolkIds) is audit-logged (hardening 2)
 *   - omitted, has own ids      -> defaults to first own id
 *   - omitted, no own ids       -> failed-precondition (client must pick from directory)
 *
 * Use this helper in every portal callable that takes a kinfolkId arg —
 * READS AND WRITES (sendKinfolkMessage, requestBookingCancellation, etc.
 * intentionally use this resolver too: staff acting on a household's
 * messages/bookings as part of the job is the intended contract, audited by
 * hardening 2 above, not a special case to avoid).
 */
export async function resolveKinfolkAccess(
  uid: string,
  requested: string | undefined,
  hasAdminClaim: boolean,
  functionName: string,
): Promise<ResolvedKinfolkAccess> {
  const staff = isStaff(uid, hasAdminClaim, functionName);

  if (staff) {
    // The `clients/{uid}` read lives inside this branch, not above it: the
    // non-staff tail below delegates to a helper that does its own read, so
    // hoisting it would double-read every non-staff call.
    const clientSnap = await db().collection('clients').doc(uid).get();
    const allowedIds: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
    if (requested) {
      const kinSnap = await db().collection('kinfolk').doc(requested).get();
      if (!kinSnap.exists) {
        throw new HttpsError('not-found', 'kinfolkId not found.');
      }
      if (!allowedIds.includes(requested)) {
        await writeAuditEntry({
          status: 'SUCCESS',
          event: AUDIT_EVENTS.OPERATOR_CROSSTENANT_ACCESS,
          severity: 'info',
          actorRole: 'AUNTIE',
          actorUid: uid,
          targetUid: requested,
          payload: { function: functionName, kinfolkId: requested },
        }).catch((err) => {
          logEvent({
            severity: 'warn',
            function: functionName,
            event: 'audit.write.failed',
            uid,
            errorMessage: (err as Error)?.message,
          });
        });
      }
      return { kinfolkId: requested, isOperator: true };
    }
    if (allowedIds.length > 0) return { kinfolkId: allowedIds[0], isOperator: true };
    throw new HttpsError(
      'failed-precondition',
      'Operator must specify a kinfolkId (no default available).',
    );
  }

  // Non-staff. This used to be a hand-copy of the discriminator that PR28b
  // extracted into `resolveNonStaffKinfolkId` for the four staff-blind write
  // callables; the two were the same discriminator apart from two message
  // strings and the return shape (this one carries `isOperator`), so they are
  // now one. The delegation runs in this direction only:
  // the helper still has no staff branch, which is exactly why those four
  // callables must NOT be routed back through this function: under RULING O-6
  // that would hand them a cross-tenant operator bypass.
  return { kinfolkId: await resolveNonStaffKinfolkId(uid, requested), isOperator: false };
}
