import { type VetClinic } from '../api/vetClinics';

/**
 * Resolving the household vet for DISPLAY.
 *
 * `household_data` is the canonical store (operator ruling 2026-08-01: "vet info
 * lives on household data, it can be seen on the kin profile", matching
 * page-specs 04-kinfolk-profile.md item 3), and it holds a `vet_clinics`
 * document id rather than copied strings. Everything shown therefore resolves
 * THROUGH the clinic, which is what makes a correction in the vet clinics
 * manager reach every household at once: there is only ever one copy.
 *
 * One resolver, used by both the household profile and the Household Data
 * screen, so the two cannot drift into showing different vets for the same
 * household. That drift is the defect this whole change exists to close, and
 * two independent read paths would quietly reintroduce it.
 */

/** The `household_data` fields this resolver reads. All optional: legacy rows. */
export interface HouseholdVetSource {
  primaryVetClinicId?: string | undefined;
  emergencyVetClinicId?: string | undefined;
  /** Legacy free text, read ONLY when the matching id is blank. Never written. */
  primaryVetName?: string | undefined;
  primaryVetPhone?: string | undefined;
  primaryVetAddress?: string | undefined;
  primaryVetHours?: string | undefined;
  emergencyVetName?: string | undefined;
  emergencyVetPhone?: string | undefined;
  emergencyVetAddress?: string | undefined;
}

/** One resolved practice, ready to render. */
export interface ResolvedVet {
  name: string;
  phone: string;
  address: string;
  hours: string;
  /**
   * True when this came from a catalog row. False means the household still
   * carries legacy free text with no clinic id, which both screens LABEL rather
   * than hide: a correction in the manager cannot reach an unlinked record, and
   * that is worth saying out loud on the screen someone reads under pressure.
   */
  linked: boolean;
  /** True when the linked clinic has been retired from the bank. */
  archived: boolean;
  /** True when the id points at a clinic that no longer exists. Fail loud. */
  dangling: boolean;
}

export const BLANK_VET: ResolvedVet = {
  name: '',
  phone: '',
  address: '',
  hours: '',
  linked: false,
  archived: false,
  dangling: false,
};

/** True when a resolved practice has anything at all worth rendering. */
export function hasVet(v: ResolvedVet): boolean {
  return v.name.trim() !== '' || v.phone.trim() !== '' || v.address.trim() !== '';
}

function resolveSlot(
  clinicId: string,
  clinics: readonly VetClinic[],
  legacy: { name: string; phone: string; address: string; hours: string },
): ResolvedVet {
  const id = clinicId.trim();
  if (id === '') {
    // Unlinked: show what is on file rather than nothing. A household that
    // predates the catalog still has a real vet, and blanking it to make a
    // point about data model purity would remove a number somebody needs.
    return {
      name: legacy.name.trim(),
      phone: legacy.phone.trim(),
      address: legacy.address.trim(),
      hours: legacy.hours.trim(),
      linked: false,
      archived: false,
      dangling: false,
    };
  }

  const clinic = clinics.find((c) => c._id === id);
  if (clinic === undefined) {
    // The id points nowhere. Never silently fall back to the legacy text: that
    // would hide a broken link behind stale data, which is precisely how a wrong
    // number survives. Reported so the screen can say so.
    return { ...BLANK_VET, linked: true, dangling: true };
  }

  return {
    name: (clinic.name ?? '').trim(),
    phone: (clinic.phone ?? '').trim(),
    address: (clinic.address ?? '').trim(),
    hours: (clinic.hours ?? '').trim(),
    linked: true,
    archived: clinic.archived === true,
    dangling: false,
  };
}

export interface HouseholdVet {
  primary: ResolvedVet;
  /** A DISTINCT practice from the primary, never folded into it. */
  emergency: ResolvedVet;
}

/**
 * The household's vet, resolved for display.
 *
 * [clinics] is the catalog. Pass an empty list while it is still loading: an
 * unresolved id then reads as `dangling`, so a caller must not render this
 * until the catalog read has actually landed.
 */
export function resolveHouseholdVet(
  household: HouseholdVetSource | null,
  clinics: readonly VetClinic[],
): HouseholdVet {
  if (household === null) return { primary: BLANK_VET, emergency: BLANK_VET };

  return {
    primary: resolveSlot(household.primaryVetClinicId ?? '', clinics, {
      name: household.primaryVetName ?? '',
      phone: household.primaryVetPhone ?? '',
      address: household.primaryVetAddress ?? '',
      // The legacy per-household hours field. Superseded by `vet_clinics.hours`,
      // which is why a LINKED household never reads this one.
      hours: household.primaryVetHours ?? '',
    }),
    emergency: resolveSlot(household.emergencyVetClinicId ?? '', clinics, {
      name: household.emergencyVetName ?? '',
      phone: household.emergencyVetPhone ?? '',
      address: household.emergencyVetAddress ?? '',
      // No legacy emergency-hours field ever existed.
      hours: '',
    }),
  };
}
