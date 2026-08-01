import { call } from '../lib/fns';

/**
 * WRITE half of the vet bank (read side + `VET_CLINICS_QUERY` in
 * `api/vetClinics.ts`).
 *
 * Every write here is a callable. `firestore.rules` now closes `vet_clinics` to
 * clients outright (`allow write: if false`), so these are the only paths and
 * not merely the preferred ones. The rule used to be `write: if isAuntie()`,
 * which is what let the Kotlin trees edit and hard-delete clinics unvalidated
 * and unaudited; the rules file carries the full note.
 *
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

/** A possible match the user must choose between. */
export interface ClinicCandidate {
  id: string;
  name: string;
  address: string;
  phone: string;
  isEmergency: boolean;
  /** False for a submission still awaiting operator approval. */
  verified: boolean;
  reason: 'name' | 'phone' | 'similar';
}
export interface SubmitVetClinicResult {
  /** `needs_choice` means NOTHING was written and `candidates` must be shown. */
  status: 'created' | 'needs_choice';
  /** '' when the caller still has a choice to make. */
  clinicId: string;
  /** True only on `status: 'created'`. */
  created: boolean;
  /** True only for a submission still awaiting approval; false for staff writes. */
  pending: boolean;
  candidates: ClinicCandidate[];
}

/**
 * Create (or resolve, on a dedupe hit) a clinic in the shared catalog.
 *
 * The blank-name guard is local on purpose: the server rejects it too, but a
 * round trip to be told the field the operator can see is empty is a round trip
 * spent to say nothing new.
 */
export async function submitVetClinic(
  clinic: NewVetClinic,
  /**
   * The ids of near-matches the operator was SHOWN and chose not to use.
   * Sending them is what authorizes a create over the top of a match.
   *
   * Deliberately NOT a `confirmCreate` boolean: a boolean could be set by a
   * client that rendered nothing, whereas these ids can only have come from the
   * previous response, so echoing them back is evidence the choice was
   * presented. See `functions/src/lib/vetClinicMatch.ts#acknowledgesAll`.
   */
  acknowledgedMatchIds: readonly string[] = [],
): Promise<SubmitVetClinicResult> {
  const name = clinic.name.trim();
  if (name === '') throw new Error('A clinic name is required.');

  return call<
    {
      name: string;
      phone: string;
      address: string;
      website: string;
      isEmergency: boolean;
      acknowledgedMatchIds: string[];
    },
    SubmitVetClinicResult
  >('submitVetClinic', {
    name,
    phone: (clinic.phone ?? '').trim(),
    address: (clinic.address ?? '').trim(),
    website: (clinic.website ?? '').trim(),
    isEmergency: clinic.isEmergency ?? false,
    acknowledgedMatchIds: [...acknowledgedMatchIds],
  });
}

/** The editable surface of an existing clinic. Mirrors `updateVetClinic`'s Args. */
export interface VetClinicEdit {
  clinicId: string;
  name: string;
  phone?: string;
  address?: string;
  website?: string;
  /** Opening hours. On the CLINIC, not on the household that picked it. */
  hours?: string;
  notes?: string;
  isEmergency?: boolean;
  /** Omit to leave the stored approval state alone; `true` approves a pending row. */
  verified?: boolean;
}

export interface UpdateVetClinicResult {
  ok: true;
  clinicId: string;
  /** Households whose denormalized copy of this clinic was rewritten. */
  householdsUpdated: number;
}

/**
 * Corrects one clinic in the shared bank.
 *
 * THIS IS A WHOLE-RECORD SAVE. An omitted optional field is CLEARED server-side,
 * which is deliberate and is why the manager seeds its form from the current row
 * and sends every field back: a patch shape could never clear a wrong address.
 *
 * `householdsUpdated` is not decoration. Households keep a denormalized copy of
 * the clinic's name/phone/address beside `vetClinicId`, and the callable
 * rewrites those copies in the same call, which is the only reason correcting a
 * clinic here reaches the number somebody reads at a doorstep. The manager
 * surfaces the count so the operator can see how far a correction travelled.
 */
export async function updateVetClinic(edit: VetClinicEdit): Promise<UpdateVetClinicResult> {
  const name = edit.name.trim();
  if (name === '') throw new Error('A clinic name is required.');
  if (edit.clinicId.trim() === '') throw new Error('A clinic id is required.');

  return call<
    {
      clinicId: string;
      name: string;
      phone: string;
      address: string;
      website: string;
      hours: string;
      notes: string;
      isEmergency: boolean;
      verified?: boolean;
    },
    UpdateVetClinicResult
  >('updateVetClinic', {
    clinicId: edit.clinicId.trim(),
    name,
    phone: (edit.phone ?? '').trim(),
    address: (edit.address ?? '').trim(),
    website: (edit.website ?? '').trim(),
    hours: (edit.hours ?? '').trim(),
    notes: (edit.notes ?? '').trim(),
    isEmergency: edit.isEmergency ?? false,
    // Spread rather than `verified: edit.verified`, so an omitted flag stays
    // absent on the wire. Sending `undefined` explicitly would be dropped by
    // JSON anyway, but the intent is worth being unambiguous about: absent
    // means "leave the approval state alone", not "set it to false".
    ...(edit.verified === undefined ? {} : { verified: edit.verified }),
  });
}

export interface ArchiveVetClinicResult {
  ok: true;
  clinicId: string;
  archived: boolean;
  /** Households still pointing at the clinic. They keep their copy of it. */
  householdCount: number;
}

/**
 * Retires a clinic from the bank, or brings it back.
 *
 * There is no delete. A household points at a clinic by id and Firestore has no
 * referential integrity, so removing the row would strand those households
 * outside `updateVetClinic`'s fan-out permanently: their vet could never be
 * corrected in bulk again. Archiving hides the clinic from both pickers and
 * leaves every household's stored name, phone and address exactly as it was, so
 * tidying the catalog never blanks a number at a doorstep.
 */
export async function archiveVetClinic(
  clinicId: string,
  archived: boolean,
): Promise<ArchiveVetClinicResult> {
  const id = clinicId.trim();
  if (id === '') throw new Error('A clinic id is required.');

  return call<{ clinicId: string; archived: boolean }, ArchiveVetClinicResult>(
    'archiveVetClinic',
    { clinicId: id, archived },
  );
}
