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
