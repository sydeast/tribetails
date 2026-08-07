import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';

/**
 * Resolves the kinfolkId a portal WRITE (or write-adjacent) callable should
 * operate on, for callables that never allow a staff/operator override:
 * submitRating, signKinPhotoUpload, confirmKinPhotoUpload, requestBooking.
 *
 * This is deliberately NOT `resolveKinfolkAccess.ts`'s staff branch reused
 * with `hasAdminClaim: false` — these four callables act on the CALLER'S OWN
 * household only, always, by design (no cross-tenant staff write), so a
 * helper with a staff branch at all would be the wrong shape here, not just
 * an unused one.
 *
 *   empty kinfolkIds                      -> failed-precondition
 *   omitted (or ''), exactly one own id   -> defaults to that id (RULING:
 *     one kinfolk, one tribe -- the normal case, unchanged)
 *   omitted (or ''), MORE THAN ONE own id -> failed-precondition (PR28b,
 *     mirrors resolveKinfolkAccess.ts's PR28a fix): a caller who omits
 *     kinfolkId gets it defaulted ONLY when exactly one id exists to default
 *     to. Two or more is a defect account, not license to guess -- and on
 *     requestBooking specifically, a wrong guess doesn't just leak a read,
 *     it WRITES a booking under a household that never asked for one.
 *   requested (non-empty) in own ids      -> ok
 *   requested (non-empty) not in own ids  -> permission-denied
 *
 * `''` is treated as omitted, not as an explicit (and therefore denied)
 * request: several callable schemas type `kinfolkId` as `z.string().optional()`
 * without `.min(1)`, so an empty string is reachable from user-controllable
 * input and must fall through the same safe path as `undefined` rather than
 * being denied as if it named a real, wrong id.
 */
export async function resolveNonStaffKinfolkId(
  uid: string,
  requested: string | undefined,
): Promise<string> {
  const clientSnap = await db().collection('clients').doc(uid).get();
  const allowed: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
  if (allowed.length === 0) {
    throw new HttpsError('failed-precondition', 'No tribes linked.');
  }
  if (!requested) {
    if (allowed.length > 1) {
      throw new HttpsError(
        'failed-precondition',
        'Multiple tribes linked to this account; kinfolkId must be specified.',
      );
    }
    return allowed[0];
  }
  if (!allowed.includes(requested)) {
    throw new HttpsError('permission-denied', 'No access.');
  }
  return requested;
}
