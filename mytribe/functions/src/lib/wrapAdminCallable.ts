import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { wrapCallable, Handler } from './wrapCallable';
import { isStaff } from './staffGate';

/**
 * Admin gate for callable functions.
 *
 * **Authorization model (post-H11 unification 2026-05-19, unified onto
 * `isStaff` per RULING O-6 2026-07-13):**
 * Primary signal is the `admin` custom claim on the caller's ID token. The
 * env-allowlist (`AUNTIE_OPERATOR_UIDS`) is preserved as a transition
 * fallback during rollout so legitimate admins are not locked out if their
 * claim is unset for any reason. When the env-allowlist path matches but
 * the claim is missing, `isStaff` emits a deprecation log so we can spot
 * and fix the gap before removing the fallback entirely.
 *
 * Firestore rules already gate writes on the claim (`isAuntie()`), so this
 * unification closes a CWE-863 gap where the two systems could grant
 * different sets of uids access.
 */
export function wrapAdminCallable<T, R>(name: string, handler: Handler<T, R>): Handler<T, R> {
  return wrapCallable(name, async (req: CallableRequest<T>): Promise<R> => {
    if (!req.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    if (!isStaff(req.auth.uid, req.auth.token?.admin === true, name)) {
      throw new HttpsError('permission-denied', 'Admin claim required.');
    }
    return handler(req);
  });
}
