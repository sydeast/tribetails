import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';
import { logEvent } from './logger';
import { isStaff } from './staffGate';
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
  if (isStaff(uid, hasAdminClaim, functionName)) return null;
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
  if (isStaff(uid, hasAdminClaim, functionName)) return true;
  const snap = await db().doc(`families/${kinfolkId}/members/${uid}`).get();
  if (!snap.exists) return true; // legacy primary
  const member = snap.data() as MemberDoc;
  if (member.status !== 'ACTIVE') return false;
  if (member.role === 'PRIMARY') return true;
  return member.permissions?.[perm] === true;
}

export async function requireKinfolkPerm(
  uid: string,
  kinfolkId: string,
  perm: keyof MemberPermissions,
  hasAdminClaim: boolean,
  functionName: string,
): Promise<MemberDoc | null> {
  if (isStaff(uid, hasAdminClaim, functionName)) return null;
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
