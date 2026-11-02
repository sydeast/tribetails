import { isPortalHiddenKinStatus, MEMORIAL_KIN_STATUS } from './kinStatus';

/**
 * #1492. What an office archive or restore writes on the household's copy of a
 * Kin, `families/{kinfolkId}/kin/{kinId}`, beside the flat `kin/{id}` doc.
 *
 * WHY THE FAMILY COPY AT ALL. `status` is parent-owned and never travels flat
 * to family (`triggers/kinMirror.ts`), and the portal roster reads the family
 * copy. So an archive written on the flat doc alone left the Kin on the
 * household's roster, and a Restore of a Kin archived through a removal
 * request (#1408, which writes both) left it hidden from them. Every office
 * archive and restore now writes both copies in one transaction:
 * `admin/kinArchive.ts#setKinArchived` and
 * `admin/kinRemovalRequests.ts#resolveKinRemovalRequest`.
 *
 * A MEMORIAL IS NOT LOST. The portal's own statuses are `active` and
 * `noLongerWithUs`. Archiving a memorial Kin stashes `noLongerWithUs` in
 * `statusBeforeArchive`, and Restore puts it back rather than writing
 * `active` over the household's goodbye.
 */

/** Stamped on an office archive or restore of the family copy, new on every such write. */
export const OFFICE_STATUS_WRITE_ID = 'officeStatusWriteId';
/** The portal status the family copy held before the office archived it, when it was a memorial. */
export const STATUS_BEFORE_ARCHIVE = 'statusBeforeArchive';

/**
 * The family-copy fields an office archive adds, besides `status: 'archived'`.
 * Only a memorial is worth remembering: anything else restores to `active`.
 */
export function archiveStash(family: Record<string, unknown>): Record<string, unknown> {
  return family['status'] === MEMORIAL_KIN_STATUS ? { [STATUS_BEFORE_ARCHIVE]: MEMORIAL_KIN_STATUS } : {};
}

/**
 * The status a Restore gives the family copy, or null when the copy is not
 * hidden from the portal and its status must be left alone (the household's
 * own value, which the office never overwrites).
 */
export function restoredFamilyStatus(family: Record<string, unknown>): 'active' | 'noLongerWithUs' | null {
  if (!isPortalHiddenKinStatus(family['status'])) return null;
  return family[STATUS_BEFORE_ARCHIVE] === MEMORIAL_KIN_STATUS ? MEMORIAL_KIN_STATUS : 'active';
}

/**
 * The flat status that goes with a family status, in the flat vocabulary
 * (`onFamilyKinWrite` writes `inactive` for a memorial).
 */
export function flatStatusFor(familyStatus: 'active' | 'noLongerWithUs'): 'active' | 'inactive' {
  return familyStatus === MEMORIAL_KIN_STATUS ? 'inactive' : 'active';
}

/** A family kin path the office may write: `families/{id}/kin/{id}`, nothing else. */
export function isFamilyKinPath(path: unknown): path is string {
  return typeof path === 'string' && /^families\/[^/]+\/kin\/[^/]+$/.test(path);
}
