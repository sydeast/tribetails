/**
 * familyProvision.ts — PURE helpers shared by the onKinfolkCreate trigger and
 * scripts/backfill_kin_adoption.ts --provision-families. No Firestore imports
 * (same leaf-module pattern as kinMirror.ts) so the operator script and its
 * vitest suite can import it without loading firebase-functions.
 *
 * The families/{kinfolkId} envelope shape REPLICATES what
 * functions/src/admin/inviteKinfolkToPortal.ts writes (lines 83-90):
 *   displayName, primaryUid: '', themeConfigRef, flags { tribePinSet,
 *   tribePinChangePending, unverified }, createdAt/updatedAt serverTimestamp.
 * Timestamps are added by the (impure) writers; everything else is built here
 * so trigger and backfill can never drift apart. `provisionedBy` is the added
 * provenance marker distinguishing trigger vs backfill vs invite provisioning.
 */

export const PROVISIONED_BY_ON_KINFOLK_CREATE = 'onKinfolkCreate';
export const PROVISIONED_BY_BACKFILL = 'backfill_kin_adoption';

function trimmed(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Household display name for a kinfolk doc. Precedence stitches together the
 * chains already in the codebase, preserving each pair's relative order:
 *   1. displayName        (scripts/backfillKinfolkNameDenormalization.ts
 *                          kinfolkDisplayName: denormalized name wins)
 *   2. businessName       (kinfolk doc field, seed_test_sandbox KinfolkDoc —
 *                          business accounts have no first/last)
 *   3. firstName lastName (inviteKinfolkToPortal householdName compose)
 *   4. email              (inviteKinfolkToPortal householdName fallback)
 *   5. "Tribe {id}"       (getMyHome final fallback — never empty)
 */
export function deriveKinfolkDisplayName(
  kinfolkId: string,
  data: Record<string, unknown>,
): string {
  const display = trimmed(data.displayName);
  if (display) return display;
  const business = trimmed(data.businessName);
  if (business) return business;
  const composed = `${trimmed(data.firstName)} ${trimmed(data.lastName)}`.trim();
  if (composed) return composed;
  const email = trimmed(data.email);
  if (email) return email;
  return `Tribe ${kinfolkId}`;
}

/**
 * Builds the families/{kinfolkId} envelope EXACTLY as inviteKinfolkToPortal
 * writes it, minus the server timestamps (writer-added) and plus the
 * `provisionedBy` provenance marker.
 */
export function buildFamilyProvisionDoc(
  kinfolkId: string,
  kinfolkData: Record<string, unknown>,
  provisionedBy: string,
): Record<string, unknown> {
  return {
    displayName: deriveKinfolkDisplayName(kinfolkId, kinfolkData),
    primaryUid: '',
    themeConfigRef: `families/${kinfolkId}/themeConfig/active`,
    flags: { tribePinSet: false, tribePinChangePending: false, unverified: false },
    provisionedBy,
  };
}

export type FamilyProvisionPlan =
  | { action: 'provision'; familyId: string; doc: Record<string, unknown> }
  | { action: 'skip'; reason: 'test_data' };

/**
 * Decides whether a freshly created kinfolk doc gets a portal family envelope.
 * Pure — existence/idempotency is enforced by the writer (create-with-exists-
 * guard), not here. Test-data kinfolk never get real portal envelopes.
 */
export function planFamilyProvision(
  kinfolkId: string,
  kinfolkData: Record<string, unknown>,
  provisionedBy: string,
): FamilyProvisionPlan {
  if (kinfolkData.isTestData === true) {
    return { action: 'skip', reason: 'test_data' };
  }
  return {
    action: 'provision',
    familyId: kinfolkId,
    doc: buildFamilyProvisionDoc(kinfolkId, kinfolkData, provisionedBy),
  };
}

/** Firestore create() rejection for an existing doc (gRPC 6 / 'already-exists'). */
export function isAlreadyExistsError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 6 || code === 'already-exists';
}
