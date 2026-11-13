import { getAdmin } from './firestoreAdmin';
import { logEvent } from './logger';
import { isAuntieOperator } from './operatorAllowlist';
import { isAuntieClaim, isOwnerClaim } from './staffGate';
import { STAFF_ROLE_AUNTIE } from './auntieAccess';

/**
 * Which side of the #944 split a staff uid is on, for a uid that is not the
 * caller (#1820).
 *
 * The Activity Log stores `AUNTIE` for the owner and a caretaker alike, and
 * before #1820 stored `PRIMARY` for every client-origin line. The admin
 * clients need to tell the two apart to print "Operator" or "Auntie", and the
 * only authority for that is the sign-in account's claims, the same ones
 * `lib/staffGate.ts` reads for the caller.
 *
 * Precedence is the gate's: caretaker first (a double-claimed account
 * included), then the owner (`admin` claim or the allowlist fallback).
 *
 * A staff record that says `staffRole: 'auntie'` (written by
 * `scripts/grant-staff-role.mjs`) answers when the claims cannot be read. An
 * account that is neither gets no entry: the caller shows "Staff" rather than
 * a guess.
 */
export type StaffRosterRole = 'owner' | typeof STAFF_ROLE_AUNTIE;

/** `getUsers` takes at most 100 identifiers per call. */
const AUTH_BATCH = 100;

/** Pure half, tested directly. `claims` is undefined when Auth could not be read for the uid. */
export function staffRoleOf(
  uid: string,
  record: { staffRole?: unknown } | undefined,
  claims: Record<string, unknown> | undefined,
): StaffRosterRole | null {
  if (claims !== undefined && isAuntieClaim(claims)) return STAFF_ROLE_AUNTIE;
  if (claims !== undefined && isOwnerClaim(claims)) return 'owner';
  if (record?.staffRole === STAFF_ROLE_AUNTIE) return STAFF_ROLE_AUNTIE;
  if (isAuntieOperator(uid)) return 'owner';
  return null;
}

export async function staffRolesByUid(
  uids: readonly string[],
  records: ReadonlyArray<{ staffRole?: unknown } | undefined>,
  context: string,
): Promise<Map<string, StaffRosterRole>> {
  const claims = new Map<string, Record<string, unknown>>();
  const unique = [...new Set(uids.filter((u) => u.length > 0))];
  for (let i = 0; i < unique.length; i += AUTH_BATCH) {
    const batch = unique.slice(i, i + AUTH_BATCH);
    try {
      const res = await getAdmin().auth().getUsers(batch.map((uid) => ({ uid })));
      for (const user of res.users) claims.set(user.uid, user.customClaims ?? {});
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'staffRoles',
        event: 'staffRoles.claimsLookupFailed',
        errorMessage: err instanceof Error ? err.message : String(err),
        extra: { context, count: batch.length },
      });
    }
  }
  const out = new Map<string, StaffRosterRole>();
  uids.forEach((uid, i) => {
    const role = staffRoleOf(uid, records[i], claims.get(uid));
    if (role !== null) out.set(uid, role);
  });
  return out;
}
