package com.tribetails.auntieos.ui.directory

/**
 * Run-4 #6 / B5 (A8): pure filter for the breed search box. Prefix matches rank first,
 * then substring matches, capped at [limit] so a 478-dog / 103-cat bank stays a short,
 * scannable dropdown. A blank query returns the alphabetical HEAD of the bank — operator
 * A8 feedback was "breed isn't pulling the DB" because the old search-only field showed
 * nothing until you typed; opening the field now reveals the seeded bank. Mirrors the web
 * breedDropdownOptions. See BreedSearchTest.
 */
fun breedSuggestions(query: String, breeds: List<String>, limit: Int = 8): List<String> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return breeds.take(limit)
    val starts = breeds.filter { it.lowercase().startsWith(q) }
    val contains = breeds.filter { !it.lowercase().startsWith(q) && it.lowercase().contains(q) }
    return (starts + contains).take(limit)
}

/**
 * Which seeded breed bank applies to a species. Dog and Cat have curated banks; every
 * other species keeps free-text until its bank is seeded, signaled by an empty list.
 * Case-insensitive on the species string. Mirrors the web helper.
 */
fun breedCatalogForSpecies(species: String, dogBreeds: List<String>, catBreeds: List<String>): List<String> =
    when (species.trim().lowercase()) {
        "dog" -> dogBreeds
        "cat" -> catBreeds
        else  -> emptyList()
    }

/** True when a species is expected to have a bank, so an empty one is a fault worth disclosing. Mirrors the web helper. */
fun speciesWantsBreedBank(species: String): Boolean =
    when (species.trim().lowercase()) {
        "dog", "cat" -> true
        else -> false
    }

/**
 * What the Breed field's disclosure note should say, or null when nothing needs
 * disclosing. Mirrors the web `breedBankNote`.
 *
 * Distinguishes a load FAILURE ([failed], the `getBreeds` callable rejected, a
 * transient fault worth retrying) from a load that SUCCEEDED but returned an
 * empty bank (the `dog_breeds` / `cat_breeds` collections are not seeded, an
 * operator-actionable gap, not a network blip). A note gated on [failed] alone
 * is the silent-empty bug this replaces: DirectoryViewModel.loadBreeds only
 * ever reported success, so an empty-but-successful load and a rejected one
 * were indistinguishable from the field's point of view -- both just an empty
 * catalog, saying nothing.
 *
 * A species with no bank at all (Bird, Reptile, ...) gets neither: an empty
 * catalog there is expected, not a fault.
 */
fun breedBankNote(species: String, catalog: List<String>, failed: Boolean): String? {
    if (!speciesWantsBreedBank(species) || catalog.isNotEmpty()) return null
    return if (failed)
        "Breed list failed to load (getBreeds), type it in."
    else
        "Breed bank is empty (dog_breeds / cat_breeds not seeded), type it in."
}
