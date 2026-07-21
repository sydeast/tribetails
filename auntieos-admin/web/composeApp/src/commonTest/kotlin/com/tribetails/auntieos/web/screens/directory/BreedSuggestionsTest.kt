package com.tribetails.auntieos.web.screens.directory

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BreedSuggestionsTest {

    private val dogs = listOf(
        "Labrador Retriever",
        "Labradoodle",
        "Poodle",
        "Pug",
        "Beagle",
        "Boxer",
    )

    @Test fun blankQuery_returnsNothing() {
        assertEquals(emptyList(), breedSuggestions("", dogs))
        assertEquals(emptyList(), breedSuggestions("   ", dogs))
    }

    @Test fun prefixMatchesRankBeforeSubstring() {
        // "oo" prefixes nothing; it is inside Labradoodle and Poodle (substring).
        // "po" prefixes Poodle; substring of nothing else. Use "po" to show prefix-first.
        val out = breedSuggestions("po", dogs)
        assertEquals("Poodle", out[0])
    }

    @Test fun substringMatchesWhenNoPrefix() {
        val out = breedSuggestions("oo", dogs)
        assertTrue(out.contains("Labradoodle"))
        assertTrue(out.contains("Poodle"))
    }

    @Test fun caseInsensitive() {
        assertEquals(listOf("Boxer"), breedSuggestions("BOX", dogs))
    }

    @Test fun respectsLimit() {
        val many = (1..50).map { "Breed $it" }
        assertEquals(8, breedSuggestions("breed", many).size)
        assertEquals(3, breedSuggestions("breed", many, limit = 3).size)
    }

    @Test fun noMatch_isEmpty() {
        assertEquals(emptyList(), breedSuggestions("zzzzz", dogs))
    }

    @Test fun catalogForSpecies_dogReturnsDogBank() {
        val dog = listOf("Pug"); val cat = listOf("Siamese")
        assertEquals(dog, breedCatalogForSpecies("Dog", dog, cat))
    }

    @Test fun catalogForSpecies_catReturnsCatBank() {
        val dog = listOf("Pug"); val cat = listOf("Siamese")
        assertEquals(cat, breedCatalogForSpecies("Cat", dog, cat))
    }

    @Test fun catalogForSpecies_isCaseInsensitive() {
        val dog = listOf("Pug"); val cat = listOf("Siamese")
        assertEquals(dog, breedCatalogForSpecies("dog", dog, cat))
        assertEquals(cat, breedCatalogForSpecies("CAT", dog, cat))
    }

    @Test fun catalogForSpecies_otherSpeciesIsEmpty_freeTextFallback() {
        val dog = listOf("Pug"); val cat = listOf("Siamese")
        assertEquals(emptyList(), breedCatalogForSpecies("Bird", dog, cat))
        assertEquals(emptyList(), breedCatalogForSpecies("", dog, cat))
    }
}
