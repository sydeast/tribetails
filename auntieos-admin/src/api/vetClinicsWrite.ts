import { call } from '../lib/fns';

/**
 * WRITE half of the vet bank (read side + `VET_CLINICS_QUERY` in
 * `api/vetClinics.ts`).
 *
 * Unlike most admin catalogs, this does NOT go through a direct client write
 * even though `firestore.rules:131` would allow one (`write: if isAuntie()`).
 * The deployed `submitVetClinic` callable already owns the piece that matters:
 * it dedupes on a normalized clinic name and returns the EXISTING id when it
 * finds a match, which is what keeps the shared bank from filling with three
 * spellings of the same hospital. A direct `addDoc` would have to reimplement
 * that check on the client, where it would race and drift. Kinfolk submissions
 * already flow through this callable; sending the admin's through it too means
 * one dedupe rule for the whole product.
 *
 * A staff caller lands `verified: true` server-side (RULING O-6 `isStaff`), so
 * a clinic the operator adds here is immediately visible to households rather
 * than queued for the operator's own approval.
 */

export interface NewVetClinic {
  name: string;
  phone?: string;
  address?: string;
  website?: string;
  isEmergency?: boolean;
}

export interface SubmitVetClinicResult {
  clinicId: string;
  /** False when the backend matched an existing clinic and returned its id. */
  created: boolean;
  /** True only for a submission still awaiting approval; false for staff writes. */
  pending: boolean;
}

/**
 * Create (or resolve, on a dedupe hit) a clinic in the shared catalog.
 *
 * The blank-name guard is local on purpose: the server rejects it too, but a
 * round trip to be told the field the operator can see is empty is a round trip
 * spent to say nothing new.
 */
export async function submitVetClinic(clinic: NewVetClinic): Promise<SubmitVetClinicResult> {
  const name = clinic.name.trim();
  if (name === '') throw new Error('A clinic name is required.');

  return call<
    { name: string; phone: string; address: string; website: string; isEmergency: boolean },
    SubmitVetClinicResult
  >('submitVetClinic', {
    name,
    phone: (clinic.phone ?? '').trim(),
    address: (clinic.address ?? '').trim(),
    website: (clinic.website ?? '').trim(),
    isEmergency: clinic.isEmergency ?? false,
  });
}
