import { collection, getDocs } from 'firebase/firestore';
import { firestore } from './firebase';
import type { GetMyKinResult, KinDto } from '../api/types';

/**
 * #1282: the household's kin roster, read straight from
 * `families/{kinfolkId}/kin` instead of through the `getMyKin` callable.
 *
 * WHY. `getMyKin` carries no `minInstances`, so the first open of Home,
 * Account, Kin, the booking wizard and every other screen that lists pets
 * waited on a Cloud Run cold start (5 to 13 s on the 2026-11-01 walk). A
 * direct read goes to Firestore, which has no cold start. The operator ruled
 * on 2026-09-12 that the portal moves to direct reads.
 *
 * WHY THE RULES ALLOW IT. `firestore.rules`, `match /families/{fid}/kin/{kinId}`:
 * `allow read: if activeMember(fid) || isStaff()`. Any ACTIVE member of the
 * household reads it, whatever their permissions, which is exactly who
 * `getMyKin` answers today. An operator stepping into a household passes
 * through `isStaff()`. `functions/test/rules/kin.test.ts` pins both halves.
 *
 * NOTHING NEW IS EXPOSED. The rule already granted this read; `getMyKin`
 * projects every field the documents hold that a household should see, and
 * the kin documents carry no admin-only fields: the_411 and dossiers live in
 * their own collections, and #1335 / #1344 keep the staff-only pet fields
 * (officeNotes, reactive, routine...) off this document by mirror and
 * backfill. The mapping below is a field-for-field copy of
 * `functions/src/portal/getMyKin.ts`, including its two quiet rules: legacy
 * admin statuses (`inactive`, `archived`) are dropped, and anything that is
 * not `noLongerWithUs` reads as `active`.
 *
 * Writes do not move. addKin / updateKin / archiveKin stay callables.
 */

/** Same set as `LEGACY_INACTIVE_KIN_STATUSES` in functions/src/lib/kinStatus.ts. */
const PORTAL_HIDDEN_KIN_STATUSES: ReadonlySet<string> = new Set(['inactive', 'archived']);

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numericOrNull(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  return null;
}

/** Maps one `families/{fid}/kin/{id}` document to the `getMyKin` wire DTO, or null when the portal hides it. */
export function kinDtoFromDoc(id: string, data: Record<string, unknown>): KinDto | null {
  const status = data['status'];
  if (typeof status === 'string' && PORTAL_HIDDEN_KIN_STATUSES.has(status)) return null;
  return {
    id,
    name: stringOrNull(data['name']),
    species: stringOrNull(data['species']),
    breed: stringOrNull(data['breed']),
    ageYears: numericOrNull(data['ageYears']),
    photoUrl: stringOrNull(data['photoUrl']),
    status: stringOrNull(status) === 'noLongerWithUs' ? 'noLongerWithUs' : 'active',
    feedingInstructions: stringOrNull(data['feedingInstructions']),
    walkingInstructions: stringOrNull(data['walkingInstructions']),
    medications: stringOrNull(data['medications']),
    allergies: stringOrNull(data['allergies']),
    emergencyNotes: stringOrNull(data['emergencyNotes']),
    sitterNotes: stringOrNull(data['sitterNotes']),
    sex: stringOrNull(data['sex']),
    weight: stringOrNull(data['weight']),
    colorMarkings: stringOrNull(data['colorMarkings']),
    spayedNeutered: data['spayedNeutered'] === true,
    vetInfo: stringOrNull(data['vetInfo']),
  };
}

/** Reads the roster for one household. Throws whatever Firestore throws; the caller decides the fallback. */
export async function readKinDirect(kinfolkId: string): Promise<GetMyKinResult> {
  const snap = await getDocs(collection(firestore, 'families', kinfolkId, 'kin'));
  const kin: KinDto[] = [];
  for (const d of snap.docs) {
    const dto = kinDtoFromDoc(d.id, d.data() as Record<string, unknown>);
    if (dto) kin.push(dto);
  }
  return { kin };
}
