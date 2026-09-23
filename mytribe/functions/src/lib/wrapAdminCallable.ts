import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { wrapCallable, Handler } from './wrapCallable';
import { staffBypass } from './staffGate';

/**
 * Staff gate for callable functions. Wraps 135 of them, which is what makes it
 * the single place the server-side admin/Auntie boundary can be enforced.
 *
 * **Authorization model (post-H11 unification 2026-05-19, unified onto the
 * one staff signal per RULING O-6 2026-07-13, split into two roles by #944
 * 2026-09-22):**
 *
 * The owner is the `admin` custom claim, with the `AUNTIE_OPERATOR_UIDS`
 * env-allowlist kept as a transition fallback so a legitimate operator is not
 * locked out if their claim is unset. When the allowlist matches and the claim
 * is missing, `isOwner` emits a deprecation log so the gap can be closed before
 * the fallback is removed.
 *
 * An Auntie is `staffRole: 'auntie'` and NO `admin` claim, and reaches a
 * callable only when `lib/auntieAccess.ts` lists it by name. **A callable that
 * is not on that list is owner-only**, so forgetting to classify one refuses a
 * contractor rather than handing her the owner's authority. `name` is already
 * a parameter here, which is why the whole boundary fits in one table instead
 * of 135 edited call sites.
 *
 * Firestore rules gate direct client access with the matching `isOwner()` /
 * `isCaretaker()` / `isStaff()` helpers. Keeping the two in step is the point:
 * a callable runs on the Admin SDK and is not subject to rules at all, so a
 * money callable has to refuse an Auntie here even where the rules would
 * already have refused her the read.
 */
export function wrapAdminCallable<T, R>(name: string, handler: Handler<T, R>): Handler<T, R> {
  return wrapCallable(name, async (req: CallableRequest<T>): Promise<R> => {
    if (!req.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    if (!staffBypass(req.auth, name)) {
      throw new HttpsError('permission-denied', 'Admin claim required.');
    }
    return handler(req);
  });
}
