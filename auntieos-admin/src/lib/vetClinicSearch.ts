import { clinicName, type VetClinic } from '../api/vetClinics';

/**
 * Rows the dropdown will show above its pinned create button. Eight, ported
 * from the archive's `vetClinicSuggestions`: enough to find the clinic, short
 * enough that the create button stays visible without scrolling.
 */
export const VET_CLINIC_SUGGESTION_CAP = 8;

/**
 * Ranked matches for the vet-clinic search box. Prefix matches first, then
 * substring matches, catalog order preserved within each rank so the list does
 * not reshuffle under the operator's cursor between keystrokes.
 *
 * A blank query returns NOTHING. This is a search box, not a catalog dump: the
 * archive behaved the same way, and dumping 100 clinics under an empty field
 * buries the create button the operator is usually reaching for.
 *
 * Emergency filtering is deliberately NOT here. The emergency picker filters
 * its own input list before calling this, so one ranking rule serves both
 * instances and cannot drift between them.
 */
export function vetClinicSuggestions(
  query: string,
  clinics: readonly VetClinic[],
  limit = VET_CLINIC_SUGGESTION_CAP,
): VetClinic[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];

  const named = clinics.filter((c) => clinicName(c) !== '');
  const starts = named.filter((c) => clinicName(c).toLowerCase().startsWith(q));
  const contains = named.filter(
    (c) => !clinicName(c).toLowerCase().startsWith(q) && clinicName(c).toLowerCase().includes(q),
  );
  return [...starts, ...contains].slice(0, limit);
}

/** The catalog entry whose name matches exactly, if there is one. */
export function exactClinicMatch(query: string, clinics: readonly VetClinic[]): VetClinic | undefined {
  const q = query.trim().toLowerCase();
  if (q === '') return undefined;
  return clinics.find((c) => clinicName(c).toLowerCase() === q);
}
