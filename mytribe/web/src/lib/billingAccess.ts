import { FirebaseError } from 'firebase/app';

/**
 * #1005. Operator ruling 2026-09-27: billing access is the business owner or
 * admin, the PRIMARY, and a SECONDARY only when the PRIMARY granted it. The
 * server decides and says so on `getMyHome.billingAccess`; the money
 * callables refuse everyone else with `permission-denied`.
 *
 * A member without billing access is not shown an error. The billing entry
 * points (the Invoices link, Home's "View invoices", the card section on
 * Account) are simply not drawn, and a direct visit to an invoice URL goes
 * back to Home.
 */

/**
 * Whether to draw billing for this `getMyHome` answer. Only an explicit
 * `false` hides it: a missing field is an older server that never gated
 * anything, and a household must not lose its bills to a deploy window. Not
 * loaded yet counts as shown, for the same reason; the server still refuses.
 */
export function billingAccessOf(home: { billingAccess?: boolean } | null | undefined): boolean {
  return home?.billingAccess !== false;
}

/** The refusal code the money callables answer a member without billing access with. */
export function isPermissionDenied(err: unknown): boolean {
  return err instanceof FirebaseError && err.code === 'functions/permission-denied';
}
