import { collection, getDocs } from 'firebase/firestore';
import { firestore } from './firebase';
import type { GetVetClinicsResult, VetClinicDto } from '../api/tribeApi';
/**
 * #1503: the shared `vet_clinics` catalog, read straight from Firestore
 * instead of through the `getVetClinics` callable.
 *
 * WHY. `getVetClinics` carries no `minInstances`, so Tribe Profile waited on a
 * Cloud Run cold start to fill its clinic picker. A direct read goes to
 * Firestore, which has no cold start. Same move as `kinDirectRead.ts` (#1282).
 *
 * WHY THE RULES ALLOW IT. `firestore.rules`, `match /vet_clinics/{clinicId}`:
 * `allow read: if signedIn()`. The callable answers the same set of callers.
 * The rule does not hide `verified: false` pending submissions or archived
 * rows, so THIS CLIENT APPLIES THE CALLABLE'S FILTER (below). That filter is a
 * presentation rule, not a security boundary: pending names and addresses were
 * already readable by any signed-in user under the rule, and the AuntieOS
 * admin reads the unfiltered collection for the same reason.
 *
 * The mapping is a field-for-field copy of `functions/src/portal/getVetClinics.ts`.
 * Writes do not move: submitVetClinic / updateVetClinic / archiveVetClinic stay
 * callables.
 */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
/**
 * Maps one `vet_clinics/{id}` document to the `getVetClinics` wire DTO, or null
 * when the portal hides it: a nameless row, an explicit pending submission
 * (`verified === false`; a MISSING flag is approved, legacy rows predate it),
 * or a retired clinic (`archived === true`; a missing flag is active).
 */
export function vetClinicDtoFromDoc(id: string, data: Record<string, unknown>): VetClinicDto | null {
  if (str(data['name']).length === 0 || data['verified'] === false || data['archived'] === true) return null;
  return {
    id,
    name: str(data['name']),
    phone: str(data['phone']),
    address: str(data['address']),
    website: str(data['website']),
    googleMapsUrl: str(data['googleMapsUrl']),
    isEmergency: data['isEmergency'] === true,
  };
}
/** Reads the approved catalog. Throws whatever Firestore throws; the caller decides the fallback. */
export async function readVetClinicsDirect(): Promise<GetVetClinicsResult> {
  const snap = await getDocs(collection(firestore, 'vet_clinics'));
  const clinics: VetClinicDto[] = [];
  for (const d of snap.docs) {
    const dto = vetClinicDtoFromDoc(d.id, d.data() as Record<string, unknown>);
    if (dto) clinics.push(dto);
  }
  return { clinics };
}
