package com.tribetails.auntieos.ui.directory

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BreedSearchTest {

    private val dogs = listOf(
        "Labrador Retriever",
        "Labradoodle",
        "Poodle",
        "Pug",
        "Beagle",
        "Boxer",
    )

    // B5 (A8): a blank query now returns the bank HEAD (up to limit) so opening the
    // breed field reveals the seeded DB instead of an empty box. Mirrors web.
    @Test fun blankQuery_returnsBankHead() {
        assertEquals(dogs, breedSuggestions("", dogs))      // 6 dogs, under the limit -> all
        assertEquals(dogs, breedSuggestions("   ", dogs))   // whitespace == blank
    }

    @Test fun blankQuery_isCappedAtLimit() {
        val many = (1..50).map { "Breed $it" }
        assertEquals(8, breedSuggestions("", many).size)
        assertEquals(many.take(8), breedSuggestions("", many))
    }

    @Test fun prefixMatchesRankBeforeSubstring() {
        assertEquals("Poodle", breedSuggestions("po", dogs)[0])
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
        assertEquals(emptyList<String>(), breedSuggestions("zzzzz", dogs))
    }

    @Test fun catalogForSpecies_dogReturnsDogBank() {
        assertEquals(listOf("Pug"), breedCatalogForSpecies("Dog", listOf("Pug"), listOf("Siamese")))
    }

    @Test fun catalogForSpecies_catReturnsCatBank() {
        assertEquals(listOf("Siamese"), breedCatalogForSpecies("Cat", listOf("Pug"), listOf("Siamese")))
    }

    @Test fun catalogForSpecies_isCaseInsensitive() {
        assertEquals(listOf("Pug"), breedCatalogForSpecies("dog", listOf("Pug"), listOf("Siamese")))
    }

    @Test fun catalogForSpecies_otherSpeciesIsEmpty() {
        assertEquals(emptyList<String>(), breedCatalogForSpecies("Bird", listOf("Pug"), listOf("Siamese")))
        assertEquals(emptyList<String>(), breedCatalogForSpecies("", listOf("Pug"), listOf("Siamese")))
    }

    @Test fun wantsBreedBank_isTrueOnlyForDogAndCat() {
        assertTrue(speciesWantsBreedBank("Dog"))
        assertTrue(speciesWantsBreedBank("cat"))
        assertEquals(false, speciesWantsBreedBank("Bird"))
        assertEquals(false, speciesWantsBreedBank(""))
    }

    // The regression this class pins: DirectoryViewModel.loadBreeds only ever
    // reported success, so a rejected getBreeds call and a call that resolved
    // to an empty bank (dog_breeds / cat_breeds not seeded) looked identical to
    // the field -- both just an empty catalog and no note. breedBankNote is the
    // pure decision the fixed ViewModel + screens now defer to, so the two
    // causes get different, collection-naming wording instead of one shared
    // silence.
    @Test fun breedBankNote_isNullOnceTheCatalogHasAnything() {
        val dogs = listOf("Pug")
        assertEquals(null, breedBankNote("Dog", dogs, failed = true))
        assertEquals(null, breedBankNote("Dog", dogs, failed = false))
    }

    @Test fun breedBankNote_isNullForASpeciesWithNoBank_evenWhenNothingLoaded() {
        assertEquals(null, breedBankNote("Bird", emptyList(), failed = true))
        assertEquals(null, breedBankNote("Bird", emptyList(), failed = false))
    }

    @Test fun breedBankNote_namesTheCallableOnAnOutrightFailure() {
        assertEquals(
            "Breed list failed to load (getBreeds), type it in.",
            breedBankNote("Dog", emptyList(), failed = true),
        )
    }

    @Test fun breedBankNote_namesTheCollectionsWhenTheCallSucceededButTheBankIsEmpty() {
        assertEquals(
            "Breed bank is empty (dog_breeds / cat_breeds not seeded), type it in.",
            breedBankNote("Dog", emptyList(), failed = false),
        )
        assertEquals(
            "Breed bank is empty (dog_breeds / cat_breeds not seeded), type it in.",
            breedBankNote("Cat", emptyList(), failed = false),
        )
    }

    @Test fun breedBankNote_givesTheTwoCausesDistinctWording() {
        val failed = breedBankNote("Dog", emptyList(), failed = true)
        val empty = breedBankNote("Dog", emptyList(), failed = false)
        assertTrue(failed != empty)
    }
}
