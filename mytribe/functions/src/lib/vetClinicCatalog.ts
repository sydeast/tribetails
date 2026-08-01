import type { Firestore } from 'firebase-admin/firestore';

/**
 * Shared logic for the `vet_clinics` catalog writes (`updateVetClinic`,
 * `archiveVetClinic`). Pure functions live here so they can be unit-tested
 * without a Firestore double, and so both callables agree on what a duplicate
 * name is and which households a clinic reaches.
 */

/**
 * Normalizes a clinic name for case/space-insensitive comparison.
 *
 * Deliberately IDENTICAL to `submitVetClinic.ts#normName`. If the two ever
 * diverge, create would dedupe under one rule and rename would collide under
 * another, and the catalog would accumulate exactly the near-duplicates the
 * dedupe exists to prevent. `test/vetClinicCatalog.test.ts` pins them equal.
 */
export function normClinicName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The editable surface of a clinic. Timestamps and `submittedBy` are not here. */
export interface VetClinicFields {
  name: string;
  phone: string;
  address: string;
  website: string;
  /**
   * Opening hours, e.g. "Mon to Fri 8a to 6p".
   *
   * Lives on the CLINIC rather than on the household that picked it. Hours are
   * a property of the practice: every household using Riverside shares
   * Riverside's hours, so storing them per household (which is what
   * `household_data.primaryVetHours` did) meant one clinic's hours were
   * recorded N times and corrected zero times.
   */
  hours: string;
  isEmergency: boolean;
  notes: string;
}

/**
 * The two `household_data` link slots a clinic can occupy.
 *
 * A household picks a regular vet and, separately, an emergency vet, so one
 * clinic can be referenced twice by the same household through different
 * fields. These live on `household_data` and NOT on `kinfolk`: operator ruling
 * 2026-08-01, "vet info lives on household data, it can be seen on the kin
 * profile", matching the canonical decision in page-specs
 * `04-kinfolk-profile.md` item 3.
 */
export const VET_LINK_SLOTS = ['primaryVetClinicId', 'emergencyVetClinicId'] as const;

export type VetLinkSlot = (typeof VET_LINK_SLOTS)[number];

/**
 * Which households reference [clinicId], by `household_data` document id.
 *
 * Two `where` queries rather than one: Firestore cannot OR across different
 * fields without a composite index and a `Filter.or`, and the two result sets
 * overlap whenever a household picked the same clinic for both slots. Merging
 * through a Set keeps such a household counted once.
 *
 * A blank [clinicId] returns nothing rather than matching every household whose
 * link field is `''`. That guard is load-bearing: an unlinked household carries
 * an empty id, so without it a single clinic edit would appear to touch every
 * unlinked household in the tribe.
 *
 * WHY THIS IS ONLY A COUNT, and never drives a write. Households store the
 * clinic ID ONLY and resolve name, phone, address and hours through it at read
 * time, so there is exactly ONE copy of a clinic's details in the product.
 * Correcting a clinic therefore needs no fan-out: the corrected value IS the
 * value every linked household reads, immediately. This exists so the operator
 * can be told how far a change reaches, not to propagate one.
 */
export async function findLinkedHouseholds(db: Firestore, clinicId: string): Promise<string[]> {
  if (clinicId.trim() === '') return [];

  const ids = new Set<string>();
  for (const slot of VET_LINK_SLOTS) {
    const snap = await db.collection('household_data').where(slot, '==', clinicId).get();
    for (const doc of snap.docs) ids.add(doc.id);
  }
  return [...ids];
}

/** Reads the stored doc into the editable shape, defaulting every absent field. */
export function readClinicFields(data: Record<string, unknown>): VetClinicFields {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    name: str(data['name']),
    phone: str(data['phone']),
    address: str(data['address']),
    website: str(data['website']),
    hours: str(data['hours']),
    isEmergency: data['isEmergency'] === true,
    notes: str(data['notes']),
  };
}

/** True when the stored doc is archived. Absent means active (the field is new). */
export function isClinicArchived(data: Record<string, unknown>): boolean {
  return data['archived'] === true;
}
