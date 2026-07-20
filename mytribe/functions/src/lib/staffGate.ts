import { isAuntieOperator } from './operatorAllowlist';
import { logEvent } from './logger';

/**
 * RULING O-6 (docs/RULING_O-6_OPERATOR_TRUST_2026-07-13.md), Q1: the single
 * staff/operator signal. The `admin` custom claim is primary;
 * `AUNTIE_OPERATOR_UIDS` is a logged transition fallback until every real
 * operator's claim is confirmed minted, at which point the fallback is
 * decommissioned (tracked separately — see the ruling doc's step 6).
 *
 * Every staff check across the portal (`resolveKinfolkAccess`, `getMyAccess`,
 * `addBookingNote`, `getKinTaleComments`, notification callables, and
 * `wrapAdminCallable`) goes through this one function. Before this ruling
 * those checks split into two independent, potentially-divergent gates (env
 * allowlist vs custom claim) — exactly the CWE-863 gap this closes.
 */
export function isStaff(uid: string | undefined, hasAdminClaim: boolean, functionName: string): boolean {
  if (!uid) return false;
  const onAllowlist = isAuntieOperator(uid);
  if (!hasAdminClaim && onAllowlist) {
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
  return hasAdminClaim || onAllowlist;
}
