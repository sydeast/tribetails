import { HttpsError } from 'firebase-functions/v2/https';
import { isAuntieOperator } from './operatorAllowlist';
import { logEvent } from './logger';
import { STAFF_ROLE_AUNTIE, auntieMayCall } from './auntieAccess';

/**
 * RULING O-6 (docs/RULING_O-6_OPERATOR_TRUST_2026-07-13.md), Q1: the single
 * staff/operator signal. The `admin` custom claim is primary;
 * `AUNTIE_OPERATOR_UIDS` is a logged transition fallback until every real
 * operator's claim is confirmed minted, at which point the fallback is
 * decommissioned (tracked separately, see the ruling doc's step 6).
 *
 * ISSUE #944 SPLIT STAFF INTO TWO ROLES and renamed `isStaff` to `isOwner` in
 * the same change. The rename is not cosmetic. The Firestore rules helper
 * `isStaff()` now means "owner OR Auntie", and leaving a server function called
 * `isStaff` that means "owner only" would put two different boundaries behind
 * one name in one repository: the CWE-863 shape RULING O-6 existed to close,
 * reintroduced by the fix for it.
 */

/**
 * The subset of a decoded ID token this module reads.
 *
 * The index signature is what makes `DecodedIdToken` assignable here: without
 * it the two types share no declared property and TypeScript rejects every call
 * site. Callers pass `req.auth` straight through, so the shape has to accept a
 * real token rather than a hand-built object.
 */
export interface StaffToken {
  admin?: unknown;
  staffRole?: unknown;
  [key: string]: unknown;
}

/** Does this token carry the caretaker role? */
export function isAuntieClaim(token: StaffToken | undefined): boolean {
  return token?.staffRole === STAFF_ROLE_AUNTIE;
}

/**
 * Does this token carry the OWNER claim?
 *
 * An Auntie carries `staffRole` and no `admin`, so in practice this is the
 * `admin` claim. The `!isAuntieClaim` conjunct covers the account that should
 * not exist: `grant-staff-role.mjs` refuses to mint both, and if one is minted
 * by hand anyway it degrades to the caretaker boundary rather than keeping the
 * owner's. `firestore.rules:isOwner()` says the same thing, and the two must
 * not be allowed to disagree.
 */
export function isOwnerClaim(token: StaffToken | undefined): boolean {
  return token?.admin === true && !isAuntieClaim(token);
}

/**
 * Is this uid the owner? The `admin` claim, or the env-allowlist fallback.
 *
 * Callers pass `isOwnerClaim(req.auth?.token)`. The ~50 portal sites still
 * passing `req.auth?.token?.admin === true` reach the same answer for every
 * account that can exist, because an Auntie has no `admin` claim at all: those
 * sites refuse her without being edited, which is the whole reason #944 split
 * the claim this way instead of adding a field beside a shared `admin: true`.
 *
 * AN AUNTIE'S UID MUST NEVER BE ADDED TO `AUNTIE_OPERATOR_UIDS`. Despite the
 * name, that list carries no role and grants owner. It is the operator's
 * bootstrap.
 */
export function isOwner(uid: string | undefined, hasOwnerClaim: boolean, functionName: string): boolean {
  if (!uid) return false;
  const onAllowlist = isAuntieOperator(uid);
  if (!hasOwnerClaim && onAllowlist) {
    // Operator passed via env-allowlist fallback only. Surface so we can
    // backfill the admin custom claim and eventually decommission the env var.
    logEvent({
      severity: 'warn',
      function: functionName,
      event: 'admin.allowlist.fallback.used',
      uid,
      extra: { note: 'AUNTIE_OPERATOR_UIDS env-allowlist path matched; admin custom claim missing. Mint the claim via setAdminClaim.' },
    });
  }
  return hasOwnerClaim || onAllowlist;
}

/**
 * The gate every staff-facing callable goes through: may this caller act as
 * staff FOR THIS FUNCTION?
 *
 * The owner always may. An Auntie may only for the callables
 * `lib/auntieAccess.ts` lists, so an unrecognised function name refuses her.
 *
 * `wrapAdminCallable` calls this for all 135 admin callables. The portal
 * callables the admin clients invoke call it directly, because they are wrapped
 * by `wrapCallable` and do their own staff check. Every other portal callable
 * keeps its owner-only bypass and needs no edit.
 */
export function staffBypass(
  auth: { uid?: string; token?: StaffToken } | undefined,
  functionName: string,
): boolean {
  const token = auth?.token;
  if (isOwner(auth?.uid, isOwnerClaim(token), functionName)) return true;
  if (!auth?.uid || !isAuntieClaim(token)) return false;
  if (!auntieMayCall(functionName)) {
    logEvent({
      severity: 'info',
      function: functionName,
      event: 'auntie.callable.refused',
      uid: auth.uid,
      extra: { note: 'The caretaker role is not on the allowlist for this callable. See lib/auntieAccess.ts.' },
    });
    return false;
  }
  return true;
}
/**
 * Refuse a caretaker outright, before any household is resolved.
 *
 * Issue #984. Two kinds of portal callable use this.
 *
 * MONEY (invoices, the invoice PDF, paying, credits, saved cards, quotes, the
 * pay links on the home screen) calls it directly. Those used to refuse an
 * Auntie only by construction: she carries no `admin` claim, so she fell into
 * the kinfolk branch, and she had no `clients/{uid}.kinfolkIds`, so that branch
 * refused her too. Operator ruling 2026-09-27 lets an Auntie be assigned
 * tribes. Holding exactly one, the kinfolk branch resolves it and she reads
 * that household's money. Holding two, the refusal she got was the one-tribe
 * rule firing: the right answer for the wrong reason. Deliberately NOT built on
 * `staffBypass`: a money callable must never be on that gate at all
 * (`test/auntieAccess.test.ts` pins the source).
 *
 * HOUSEHOLD callables reach it through `householdStaffFlag` below, when the
 * allowlist does not admit her to that callable.
 *
 * It keys on the role, not on how many tribes she holds, so it cannot drift
 * when her assignments change. A token carrying both claims is refused as
 * well, matching `isOwnerClaim`. Kinfolk and strangers pass through untouched.
 */
export function refuseAuntie(
  auth: { uid?: string; token?: StaffToken } | undefined,
  functionName: string,
): void {
  if (!isAuntieClaim(auth?.token)) return;
  logEvent({
    severity: 'info',
    function: functionName,
    event: 'auntie.callable.refused',
    uid: auth?.uid,
    extra: { note: 'A caretaker never acts as the household. Money, or a household callable not on lib/auntieAccess.ts.' },
  });
  throw new HttpsError('permission-denied', 'This is not available to caretaker accounts.');
}
/**
 * The staff flag for a portal callable that resolves a household through
 * `resolveKinfolkAccess`.
 *
 * Same answer as `staffBypass` for the owner, for an Auntie on the allowlist,
 * and for kinfolk. The one difference: an Auntie the allowlist does NOT admit
 * is refused here instead of falling into the kinfolk branch, where one
 * assigned tribe would let her act as that household and two would trip the
 * one-tribe rule. `firestore.rules:isKinfolk()` makes the same call: a
 * caretaker is never a kinfolk. The allowlist stays the single switch.
 */
export function householdStaffFlag(
  auth: { uid?: string; token?: StaffToken } | undefined,
  functionName: string,
): boolean {
  if (staffBypass(auth, functionName)) return true;
  refuseAuntie(auth, functionName);
  return false;
}
