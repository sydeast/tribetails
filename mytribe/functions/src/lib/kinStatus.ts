/**
 * The Kin (pet) status vocabulary, in one place.
 *
 * THE PORTAL CONTRACT IS BINARY. A pet is either `active` or `noLongerWithUs`
 * (the memorial state). `portal/kinWrites.ts` is the only writer of those two
 * values, and `web/src/api/types.ts` is the only consumer.
 *
 * A MISSING `status` MEANS ACTIVE. Several write paths create a family kin doc
 * without one (the flat -> family mirror merging into a doc that does not exist
 * yet, plus legacy imports), so absence has to be a legal, visible state rather
 * than a document that quietly falls out of every query.
 *
 * `inactive` and `archived` are LEGACY AuntieOS spellings on the flat `kin/`
 * collection (the admin still writes `archived` directly). They mean not-active
 * and are not part of the portal contract, so the portal hides them rather than
 * rendering them as one of its two states.
 */

/** What a kin doc means when it carries no `status` field. */
export const DEFAULT_KIN_STATUS = 'active';

/** The portal's memorial state: still listed, rendered as remembrance. */
export const MEMORIAL_KIN_STATUS = 'noLongerWithUs';

/**
 * Legacy AuntieOS-only spellings. Outside the portal's binary contract, so the
 * portal hides docs carrying them instead of coercing them to a state the
 * kinfolk would misread.
 */
export const LEGACY_INACTIVE_KIN_STATUSES: ReadonlySet<string> = new Set([
  'inactive',
  'archived',
]);

/**
 * Every status that means "not an active pet", memorial included. Use this for
 * care/roster decisions (who is still being walked, whose name belongs in a
 * notification). Do NOT use it to decide portal visibility: a memorial pet is
 * inactive but is still listed.
 */
export const INACTIVE_KIN_STATUSES: ReadonlySet<string> = new Set([
  MEMORIAL_KIN_STATUS,
  ...LEGACY_INACTIVE_KIN_STATUSES,
]);

/** True when the pet is not in active care. Missing status counts as active. */
export function isInactiveKinStatus(status: unknown): boolean {
  return typeof status === 'string' && INACTIVE_KIN_STATUSES.has(status);
}

/**
 * True when the portal's Kin list should omit the doc entirely. ONLY the legacy
 * admin spellings qualify: `active`, `noLongerWithUs`, an absent status, and
 * anything unrecognised all stay visible, because a pet vanishing with no error
 * is worse than a pet shown in the wrong state.
 */
export function isPortalHiddenKinStatus(status: unknown): boolean {
  return typeof status === 'string' && LEGACY_INACTIVE_KIN_STATUSES.has(status);
}
