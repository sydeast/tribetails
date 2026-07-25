/**
 * Breed dropdown ranking and catalog selection, ported from the Kotlin twins so
 * all three surfaces filter the seeded bank the same way:
 *   `web/composeApp/.../directory/KinEditScreen.kt` (breedSuggestions,
 *   breedDropdownOptions, breedCatalogForSpecies) and
 *   `android/.../ui/directory/BreedSearch.kt`.
 *
 * The React port dropped the breed dropdown entirely and left a plain text box,
 * so the 478-dog / 103-cat bank behind `getBreeds` was unreachable from the
 * admin. These helpers are the pure half of putting it back.
 */

/**
 * Rows shown while the operator is typing. Eight, same as the Kotlin default
 * and the vet-clinic picker: enough to find the breed, short enough to scan.
 */
export const BREED_SUGGESTION_CAP = 8;

/**
 * Rows shown when the field is opened but nothing is typed yet. Larger than the
 * typed cap because this is a browse, not a filter.
 */
export const BREED_DROPDOWN_CAP = 12;

/**
 * Ranked matches for a typed query: prefix matches first, then substring
 * matches, catalog order preserved inside each rank so the list does not
 * reshuffle under the cursor between keystrokes.
 *
 * A blank query returns nothing here. Opening the field is handled by
 * `breedDropdownOptions`, which shows the catalog head instead; keeping the two
 * behaviours in separate functions is what the Kotlin does, and it is why the
 * "blank shows the bank" fix could not silently change what typing does.
 */
export function breedSuggestions(
  query: string,
  breeds: readonly string[],
  limit = BREED_SUGGESTION_CAP,
): string[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const starts = breeds.filter((b) => b.toLowerCase().startsWith(q));
  const contains = breeds.filter(
    (b) => !b.toLowerCase().startsWith(q) && b.toLowerCase().includes(q),
  );
  return [...starts, ...contains].slice(0, limit);
}

/**
 * What the dropdown lists. Blank input returns the catalog HEAD so the seeded
 * bank is visible the moment the field opens; operator A8 feedback on the old
 * search-only field was "breed isn't pulling the DB", because it showed nothing
 * until you typed. A typed query filters through `breedSuggestions`.
 *
 * An empty catalog returns empty, which is the signal the field uses to degrade
 * to a plain text input for species whose bank is not seeded.
 */
export function breedDropdownOptions(
  query: string,
  catalog: readonly string[],
  limit = BREED_DROPDOWN_CAP,
): string[] {
  const q = query.trim();
  return q === '' ? catalog.slice(0, limit) : breedSuggestions(q, catalog, limit);
}

/**
 * Which seeded bank applies to a species. Dog and Cat have curated banks; every
 * other species keeps free text until its bank is seeded, signalled by an empty
 * list. Case-insensitive, because the admin's species field is free text and
 * "dog" must reach the same bank as "Dog".
 */
export function breedCatalogForSpecies(
  species: string,
  dogBreeds: readonly string[],
  catBreeds: readonly string[],
): readonly string[] {
  switch (species.trim().toLowerCase()) {
    case 'dog':
      return dogBreeds;
    case 'cat':
      return catBreeds;
    default:
      return [];
  }
}

/** True when a species is expected to have a bank, so an empty one is a fault worth disclosing. */
export function speciesWantsBreedBank(species: string): boolean {
  const s = species.trim().toLowerCase();
  return s === 'dog' || s === 'cat';
}

/** True when the current value already names a breed in the bank, exactly. */
export function isExactBreed(value: string, catalog: readonly string[]): boolean {
  const v = value.trim().toLowerCase();
  if (v === '') return false;
  return catalog.some((b) => b.toLowerCase() === v);
}
