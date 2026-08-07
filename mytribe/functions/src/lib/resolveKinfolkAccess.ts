import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';
import { isStaff } from './staffGate';
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
 * Non-staff: must have `clients/{uid}.kinfolkIds`.
 *   - empty kinfolkIds               -> failed-precondition
 *   - omitted, exactly one own id    -> defaults to that id (the normal case:
 *     RULING is one kinfolk, one tribe)
 *   - omitted, MORE THAN ONE own id  -> failed-precondition (PR28a: this is a
 *     defect account, not a caller entitled to a guess — refuses rather than
 *     silently handing back another household's data)
 *   - requested in kinfolkIds        -> ok
 *   - requested not in own ids       -> permission-denied
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
  const clientSnap = await db().collection('clients').doc(uid).get();
  const allowedIds: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];

  if (staff) {
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

  if (allowedIds.length === 0) {
    throw new HttpsError('failed-precondition', 'No tribes linked to this account.');
  }
  // PR28a: a caller who omits kinfolkId gets it defaulted ONLY when there is
  // exactly one linked id to default to. With two or more, "pick the first"
  // was silently returning another household's data (pets, schedule,
  // contacts, invoices) to a caller who never asked for it — the operator
  // ruling is one kinfolk, one tribe, so an account with more than one is a
  // defect state, not a multi-household caller to route on faith. Same
  // failed-precondition family as the two account-state checks already in
  // this file (no ids above, staff-no-default at line ~74): the argument
  // itself isn't malformed, the account's state makes the omission unsafe to
  // guess through.
  if (!requested) {
    if (allowedIds.length > 1) {
      throw new HttpsError(
        'failed-precondition',
        'Multiple tribes linked to this account; kinfolkId must be specified.',
      );
    }
    return { kinfolkId: allowedIds[0], isOperator: false };
  }
  if (!allowedIds.includes(requested)) {
    throw new HttpsError('permission-denied', 'You do not have access to this tribe.');
  }
  return { kinfolkId: requested, isOperator: false };
}
