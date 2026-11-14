import { type VetClinic } from '../api/vetClinics';
import { resolveHouseholdVet, hasVet, BLANK_VET, type HouseholdVetSource, type ResolvedVet } from './householdVet';

/**
 * #1908 kin-vet, owner ruling 2026-11-12: "The vet field on the Kin profile in
 * both view & edit mode is read only and pulls its data from the vet listed on
 * the household. The edit view should have a checkbox (defaulted unmarked) that
 * when checked it allows the editor to select a different vet from the drop
 * down list."
 *
 * A Kin stores only `ownVetClinicId`, a `vet_clinics` id for this Kin alone, or
 * '' when it goes to the household's vet. The household's vet is never copied
 * onto the Kin, so a change on the household reaches every Kin that follows it.
 */
export interface KinVet {
  /** The practice to show; BLANK_VET when there is none. */
  vet: ResolvedVet;
  /** True when the vet shown is the household's, not one picked for this Kin. */
  fromHousehold: boolean;
}

/** The vet a Kin goes to. [clinics] must be the loaded catalog (see resolveHouseholdVet). */
export function resolveKinVet(
  ownVetClinicId: string,
  household: HouseholdVetSource | null,
  clinics: readonly VetClinic[],
): KinVet {
  const own = ownVetClinicId.trim();
  if (own !== '') {
    // Resolved through the same slot rules as the household's, so a Kin vet that
    // no longer exists reads as a broken link, never as the household's vet.
    const vet = resolveHouseholdVet({ primaryVetClinicId: own }, clinics).primary;
    return { vet, fromHousehold: false };
  }
  return { vet: household === null ? BLANK_VET : resolveHouseholdVet(household, clinics).primary, fromHousehold: true };
}

/** One line for a resolved vet: "Cedar Animal Care · 555 0142 · 1 Main St". */
export function vetLine(v: ResolvedVet): string {
  if (v.dangling) return 'The vet on file is no longer on the list.';
  return [v.name, v.phone, v.address].map((s) => s.trim()).filter((s) => s !== '').join(' · ');
}

/** True when [v] has anything worth a row. */
export function showsVet(v: ResolvedVet): boolean {
  return hasVet(v) || v.dangling;
}
