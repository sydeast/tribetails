import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';
import { logEvent } from './logger';
import { isOwner } from './staffGate';
import type { MemberDoc, MemberPermissions } from './schema';

export async function loadMember(familyId: string, uid: string): Promise<MemberDoc> {
  const snap = await db().doc(`families/${familyId}/members/${uid}`).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'permission-denied');
  const data = snap.data() as MemberDoc;
  if (data.status !== 'ACTIVE') throw new HttpsError('permission-denied', 'permission-denied');
  return data;
}

export function requirePerm(member: MemberDoc, perm: keyof MemberDoc['permissions']): void {
  if (member.role === 'PRIMARY') return;
  if (member.permissions?.[perm] === true) return;
  throw new HttpsError('permission-denied', 'permission-denied');
}

export function requirePrimary(member: MemberDoc): void {
  if (member.role !== 'PRIMARY') {
    throw new HttpsError('permission-denied', 'permission-denied');
  }
}

/**
 * Enforce a member permission for a portal write/billing/messaging action.
 *
 * CRITICAL-4: portal callables historically authorized only on
 * `clients/{uid}.kinfolkIds` membership and never consulted the member
 * permission model, so a restricted secondary (e.g. `kintales_only`) could edit
 * pets, pay/redeem invoices, write home-access secrets, and message the
 * business. This is the single gate every such callable must call right after it
 * resolves the kinfolkId.
 *
 * Behavior:
 * - Auntie operators bypass — they are NOT household members (no member doc) and
 *   already pass their own allowlist/override checks.
 * - Member doc EXISTS: must be ACTIVE, then `requirePerm` (PRIMARY passes; a
 *   secondary needs the specific flag set to true).
 * - Member doc MISSING: legacy single-primary account that predates the member
 *   model (restricted secondaries are always created WITH a member doc via
 *   acceptInvite, so they cannot reach this branch). Fall back to the caller's
 *   existing kinfolkIds membership check (allow) but log a warning so the
 *   operator can backfill and later tighten. This is the deliberate anti-lockout
 *   path.
 * - Member doc INACTIVE (status !== 'ACTIVE'): denied.
 *
 * Returns the resolved member doc when one exists and is ACTIVE (so callers can
 * label audit entries with the real role), or `null` for the operator-bypass and
 * legacy-missing branches.
 */
/**
 * Enforce that the caller is the PRIMARY member of a family (operator bypasses).
 * Missing member doc falls back to allow (legacy single-primary account; same
 * anti-lockout rationale as requireKinfolkPerm). Returns the member, or null for
 * operator/legacy.
 */
export async function requireKinfolkPrimary(
  uid: string,
  kinfolkId: string,
  hasAdminClaim: boolean,
  functionName: string,
): Promise<MemberDoc | null> {
  if (isOwner(uid, hasAdminClaim, functionName)) return null;
  const snap = await db().doc(`families/${kinfolkId}/members/${uid}`).get();
  if (!snap.exists) {
    logEvent({ severity: 'warn', function: 'requireKinfolkPrimary', event: 'portal.member.missing', uid, familyId: kinfolkId, extra: { kinfolkId } });
    return null;
  }
  const member = snap.data() as MemberDoc;
  if (member.status !== 'ACTIVE') throw new HttpsError('permission-denied', 'permission-denied');
  requirePrimary(member);
  return member;
}

/**
 * Non-throwing variant of requireKinfolkPerm for read-redaction decisions.
 * Operator -> true; member exists -> requirePerm semantics (PRIMARY true,
 * else the flag); missing member doc -> true (legacy primary, same
 * anti-lockout rationale). Inactive -> false.
 */
export async function hasKinfolkPerm(
  uid: string,
  kinfolkId: string,
  perm: keyof MemberPermissions,
  hasAdminClaim: boolean,
  functionName: string,
): Promise<boolean> {
  if (isOwner(uid, hasAdminClaim, functionName)) return true;
  const snap = await db().doc(`families/${kinfolkId}/members/${uid}`).get();
  if (!snap.exists) return true; // legacy primary
  const member = snap.data() as MemberDoc;
  if (member.status !== 'ACTIVE') return false;
  if (member.role === 'PRIMARY') return true;
  return member.permissions?.[perm] === true;
}

/**
 * BILLING ACCESS (#1005, operator ruling 2026-09-27): the business owner or
 * admin, the household PRIMARY, and a SECONDARY only when the PRIMARY granted
 * `billing_full`. Every portal read of money asks this one question, and
 * since D-2026-09-28-BILLING-ACCESS-PAYS every money action asks it too
 * (through `requireBillingActor`).
 *
 * CALL IT ONLY AFTER THE HOUSEHOLD IS RESOLVED (`resolveKinfolkAccess` or
 * `resolveNonStaffKinfolkId`). It answers through `hasKinfolkPerm`, which says
 * yes when the caller has no member doc in the household (the legacy-primary
 * anti-lockout). On its own that would admit anyone naming a household that is
 * not theirs; after the household check it admits only a real account holder
 * who predates the member model.
 */
export async function hasBillingAccess(
  uid: string,
  kinfolkId: string,
  hasAdminClaim: boolean,
  functionName: string,
): Promise<boolean> {
  return hasKinfolkPerm(uid, kinfolkId, 'billing_full', hasAdminClaim, functionName);
}

/** The refusal every billing read throws, so the clients key off one code. */
export const BILLING_ACCESS_REFUSAL = 'Billing access is required to see invoices and account balance.';

/**
 * The refusal every billing ACTION throws (paying, using credit, answering a
 * quote, saved cards). Same `permission-denied` code as the read refusal and
 * the same opening words, so a client matching "Billing access is required"
 * treats both alike.
 */
export const BILLING_ACTION_REFUSAL = 'Billing access is required to pay, use credit, answer quotes or manage cards.';

/** Throwing form of `hasBillingAccess`. Same precondition: household resolved first. */
export async function requireBillingAccess(
  uid: string,
  kinfolkId: string,
  hasAdminClaim: boolean,
  functionName: string,
): Promise<void> {
  if (await hasBillingAccess(uid, kinfolkId, hasAdminClaim, functionName)) return;
  logEvent({
    severity: 'info',
    function: functionName,
    event: 'portal.billing.refused',
    uid,
    familyId: kinfolkId,
    extra: { reason: 'no_billing_access' },
  });
  throw new HttpsError('permission-denied', BILLING_ACCESS_REFUSAL);
}

/**
 * THE GATE ON EVERY PORTAL MONEY ACTION (D-2026-09-28-BILLING-ACCESS-PAYS,
 * operator ruling 2026-09-28, docket Q7): "billing access includes paying,
 * using credit, answering quotes and saved cards." `payInvoice`,
 * `redeemCredit`, `acceptQuote` / `denyQuote` and the saved-card callables in
 * `portal/billing.ts` used `requireKinfolkPrimary`, so a SECONDARY the PRIMARY
 * granted `billing_full` could see a bill and not pay it.
 *
 * Who passes is exactly who `hasBillingAccess` says yes to, branch for branch:
 * - operator (`isOwner`) bypasses, returns null;
 * - no member doc: the legacy single-primary account, allowed, returns null,
 *   with the same `portal.member.missing` warning the primary gate logged;
 * - member not ACTIVE: refused;
 * - PRIMARY: allowed;
 * - SECONDARY with `billing_full === true`: allowed;
 * - anyone else: refused with BILLING_ACTION_REFUSAL and the same
 *   `portal.billing.refused` log line `requireBillingAccess` writes.
 *
 * Returns the member doc when there is one, so the caller can name the real
 * role (PRIMARY or SECONDARY) on its audit entry. Same precondition as
 * `hasBillingAccess`: CALL IT ONLY AFTER THE HOUSEHOLD IS RESOLVED against the
 * caller's own `kinfolkIds`, or the legacy branch admits a stranger.
 */
export async function requireBillingActor(
  uid: string,
  kinfolkId: string,
  hasAdminClaim: boolean,
  functionName: string,
): Promise<MemberDoc | null> {
  if (isOwner(uid, hasAdminClaim, functionName)) return null;
  const snap = await db().doc(`families/${kinfolkId}/members/${uid}`).get();
  if (!snap.exists) {
    logEvent({
      severity: 'warn',
      function: 'requireBillingActor',
      event: 'portal.member.missing',
      uid,
      familyId: kinfolkId,
      extra: { kinfolkId, caller: functionName },
    });
    return null; // legacy primary; same anti-lockout as hasKinfolkPerm
  }
  const member = snap.data() as MemberDoc;
  const allowed =
    member.status === 'ACTIVE' &&
    (member.role === 'PRIMARY' || member.permissions?.billing_full === true);
  if (allowed) return member;
  logEvent({
    severity: 'info',
    function: functionName,
    event: 'portal.billing.refused',
    uid,
    familyId: kinfolkId,
    extra: { reason: 'no_billing_access', action: true },
  });
  throw new HttpsError('permission-denied', BILLING_ACTION_REFUSAL);
}

export async function requireKinfolkPerm(
  uid: string,
  kinfolkId: string,
  perm: keyof MemberPermissions,
  hasAdminClaim: boolean,
  functionName: string,
): Promise<MemberDoc | null> {
  if (isOwner(uid, hasAdminClaim, functionName)) return null;
  const snap = await db().doc(`families/${kinfolkId}/members/${uid}`).get();
  if (!snap.exists) {
    logEvent({
      severity: 'warn',
      function: 'requireKinfolkPerm',
      event: 'portal.member.missing',
      uid,
      familyId: kinfolkId,
      extra: { kinfolkId, perm },
    });
    return null; // legacy primary; existing kinfolkIds membership check already gated this caller
  }
  const member = snap.data() as MemberDoc;
  if (member.status !== 'ACTIVE') throw new HttpsError('permission-denied', 'permission-denied');
  requirePerm(member, perm);
  return member;
}
