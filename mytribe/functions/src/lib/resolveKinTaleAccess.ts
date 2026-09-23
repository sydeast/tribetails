import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';
import { isOwner } from './staffGate';

export interface ResolvedTaleAccess {
  kinfolkId: string;
  isStaffCaller: boolean;
}

/**
 * RULING O-6 (docs/RULING_O-6_OPERATOR_TRUST_2026-07-13.md), Q2: resolves +
 * authorizes access to a `kin_care_reports/{taleId}` doc by deriving
 * `kinfolkId` FROM THE TALE DOC ITSELF — the source of truth — never from a
 * client-supplied argument. A supplied `kinfolkId` (kept for old-client
 * compat) is validated for EQUALITY only against the derived value; it is
 * never itself trusted as the authority.
 *
 * `not-found` (not `permission-denied`) on every failure path — tale
 * missing, non-staff non-member, or a mismatched supplied kinfolkId — to
 * avoid an existence oracle for a resource the caller has no business
 * probing.
 */
export async function resolveKinTaleAccess(
  taleId: string,
  uid: string,
  requested: string | undefined,
  hasAdminClaim: boolean,
  functionName: string,
): Promise<ResolvedTaleAccess> {
  const taleSnap = await db().doc(`kin_care_reports/${taleId}`).get();
  const derivedKinfolkId = taleSnap.exists ? (taleSnap.data()?.['kinfolkId'] as string | undefined) : undefined;
  if (!derivedKinfolkId) {
    throw new HttpsError('not-found', 'kinTale not found');
  }

  // Authorize BEFORE checking a supplied kinfolkId for equality — checking
  // equality first would let a non-member holding a valid taleId brute-force
  // `requested` and learn which household owns the tale via invalid-argument
  // vs not-found (an existence oracle the doc comment above already promises
  // this function avoids).
  const isStaffCaller = isOwner(uid, hasAdminClaim, functionName);
  if (!isStaffCaller) {
    const clientSnap = await db().collection('clients').doc(uid).get();
    const allowedIds: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
    if (!allowedIds.includes(derivedKinfolkId)) {
      throw new HttpsError('not-found', 'kinTale not found');
    }
  }

  if (requested && requested !== derivedKinfolkId) {
    throw new HttpsError('invalid-argument', 'kinfolkId does not match this KinTale.');
  }
  return { kinfolkId: derivedKinfolkId, isStaffCaller };
}
