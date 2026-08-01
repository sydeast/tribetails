import { type VetClinic, isApprovedClinic, isActiveClinic } from '../api/vetClinics';

/**
 * Pure logic behind the Vet clinics manager screen (punchlist B4).
 *
 * Kept out of the component for the usual reason, plus one specific to this
 * screen: the household-reference count decides whether the operator is shown
 * "retire this" or "3 households read this number", and that rule is worth
 * testing without a render.
 */

/** The `kinfolk` fields this screen reads. Everything optional: legacy rows. */
export interface VetLinkedKinfolk {
  _id: string;
  displayName?: string | undefined;
  lastName?: string | undefined;
  vetClinicId?: string | undefined;
  vetClinicName?: string | undefined;
  emergencyVetClinicId?: string | undefined;
  emergencyVetClinicName?: string | undefined;
}

/** Same normalization the server dedupes and collides names by. */
export function normClinicName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * How many households read this clinic's number, and how.
 *
 * TWO KINDS OF REFERENCE, counted separately on purpose.
 *
 *  `linked` households carry this clinic's document id. They are the ones
 *  `updateVetClinic`'s fan-out can reach, so a correction here lands on their
 *  record automatically.
 *
 *  `unlinked` households merely have the same clinic NAME typed on file with an
 *  empty id. Every household written before 2026-07-25 is in this state. They
 *  are the ones a correction CANNOT reach, which is exactly why the count is
 *  split rather than summed: telling the operator "5 households" when only 2 of
 *  them will actually receive the corrected phone number would overstate what
 *  the save just did, on the one screen where that number matters most.
 *
 * Android counts by name only (`vetClinicHouseholdCount`, AdminSettingsScreen
 * .kt), which conflates the two. This is the id-first version.
 */
export interface ClinicUsage {
  linked: number;
  unlinked: number;
}

export function clinicUsage(
  clinic: VetClinic,
  households: readonly VetLinkedKinfolk[],
): ClinicUsage {
  const id = clinic._id;
  const name = normClinicName(clinic.name ?? '');
  let linked = 0;
  let unlinked = 0;

  for (const h of households) {
    const idHit =
      (h.vetClinicId ?? '') === id || (h.emergencyVetClinicId ?? '') === id;
    if (idHit) {
      linked += 1;
      continue;
    }
    // Only counted as a name match when the household has NO id in that slot.
    // A household linked to a different clinic that happens to share a name is
    // not this clinic's household, and must not be counted as one.
    if (name === '') continue;
    const looseRegular =
      (h.vetClinicId ?? '') === '' && normClinicName(h.vetClinicName ?? '') === name;
    const looseEmergency =
      (h.emergencyVetClinicId ?? '') === '' &&
      normClinicName(h.emergencyVetClinicName ?? '') === name;
    if (looseRegular || looseEmergency) unlinked += 1;
  }

  return { linked, unlinked };
}

/** Case-insensitive match over name, phone and address. Blank matches all. */
export function clinicMatchesQuery(clinic: VetClinic, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [clinic.name, clinic.phone, clinic.address]
    .map((s) => (s ?? '').toLowerCase())
    .some((s) => s.includes(q));
}

export function filterClinics(all: readonly VetClinic[], query: string): VetClinic[] {
  return all.filter((c) => clinicMatchesQuery(c, query));
}

/** Kinfolk submissions awaiting the operator's approval. */
export function pendingClinics(all: readonly VetClinic[]): VetClinic[] {
  return all.filter((c) => !isApprovedClinic(c) && isActiveClinic(c));
}

/** Live catalog rows: approved and not retired. */
export function activeClinics(all: readonly VetClinic[]): VetClinic[] {
  return all.filter((c) => isApprovedClinic(c) && isActiveClinic(c));
}

/** Retired rows, kept so their households' ids still resolve. */
export function archivedClinics(all: readonly VetClinic[]): VetClinic[] {
  return all.filter((c) => !isActiveClinic(c));
}

/** The editable form behind one clinic card. */
export interface ClinicDraft {
  name: string;
  phone: string;
  address: string;
  website: string;
  hours: string;
  notes: string;
  isEmergency: boolean;
}

/** Seeds a draft from the stored row, defaulting every absent field. */
export function draftFromClinic(c: VetClinic): ClinicDraft {
  return {
    name: c.name ?? '',
    phone: c.phone ?? '',
    address: c.address ?? '',
    website: c.website ?? '',
    hours: c.hours ?? '',
    notes: c.notes ?? '',
    isEmergency: c.isEmergency === true,
  };
}

/** True when [draft] differs from what is stored, comparing trimmed values. */
export function draftChanged(c: VetClinic, draft: ClinicDraft): boolean {
  const stored = draftFromClinic(c);
  return (
    stored.name.trim() !== draft.name.trim() ||
    stored.phone.trim() !== draft.phone.trim() ||
    stored.address.trim() !== draft.address.trim() ||
    stored.website.trim() !== draft.website.trim() ||
    stored.hours.trim() !== draft.hours.trim() ||
    stored.notes.trim() !== draft.notes.trim() ||
    stored.isEmergency !== draft.isEmergency
  );
}

/** A save needs a real name AND a real change. */
export function canSaveDraft(c: VetClinic, draft: ClinicDraft): boolean {
  return draft.name.trim() !== '' && draftChanged(c, draft);
}

/**
 * True when saving [draft] would collide with another clinic's name, under the
 * same normalization the server refuses on.
 *
 * The server is the enforcement; this is a courtesy that catches it before the
 * round trip and lets the field carry the message inline.
 */
export function draftNameCollides(
  clinicId: string,
  draft: ClinicDraft,
  all: readonly VetClinic[],
): boolean {
  const wanted = normClinicName(draft.name);
  if (wanted === '') return false;
  return all.some((c) => c._id !== clinicId && normClinicName(c.name ?? '') === wanted);
}

/** Two-letter monogram for a clinic's avatar. Mirrors Android's. */
export function clinicMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}
