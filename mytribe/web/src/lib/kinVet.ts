import type { KinDto, KinVetDto } from '../api/types';
import type { VetClinicDto, VetClinicSummaryDto } from '../api/tribeApi';

/**
 * #1908 kin-vet (owner ruling 2026-11-12): a Kin goes to the household's vet,
 * the one on the Tribe Profile, unless it has a vet of its own
 * (`ownVetClinicId`), picked from the same area vet list.
 *
 * getMyKin resolves this on the server (`KinDto.vet`). A roster read straight
 * from Firestore (lib/kinDirectRead.ts) cannot: the household's vet lives on a
 * staff-only document. Then the screen resolves it from what it already loads,
 * the vet list and the Tribe Profile's vet.
 */
export function resolveKinVet(
  kin: Pick<KinDto, 'ownVetClinicId' | 'vet'>,
  householdVet: VetClinicSummaryDto | null | undefined,
  clinics: readonly VetClinicDto[],
): KinVetDto | null {
  if (kin.vet !== undefined) return kin.vet;
  const own = (kin.ownVetClinicId ?? '').trim();
  if (own !== '') {
    const c = clinics.find((x) => x.id === own);
    return c ? { clinic: summary(c), fromHousehold: false } : null;
  }
  return householdVet ? { clinic: summary(householdVet), fromHousehold: true } : null;
}

/** True when the screen has to load the vet list and Tribe Profile to resolve this Kin's vet. */
export function kinVetNeedsLookup(kin: Pick<KinDto, 'vet'> | null | undefined): boolean {
  return kin != null && kin.vet === undefined;
}

function summary(c: { id: string; name: string; phone: string; address: string; isEmergency: boolean }): KinVetDto['clinic'] {
  return { id: c.id, name: c.name, phone: c.phone, address: c.address, isEmergency: c.isEmergency };
}

/** "Name · phone · address", the one line a vet is shown as. */
export function vetLine(c: { name: string; phone: string; address: string }, formatPhone: (p: string) => string): string {
  return [c.name, formatPhone(c.phone), c.address].filter((x) => x.trim() !== '').join(' · ');
}
