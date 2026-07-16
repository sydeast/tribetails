package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.screens.directory.breedDropdownOptions
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * B5: the breed bank (478 dogs / 103 cats) loaded fine but was INVISIBLE — the field
 * only showed matches after typing (breedSuggestions returns empty for blank input),
 * and there was no dropdown to browse. breedDropdownOptions makes the bank visible on
 * open by returning the catalog head when blank, then filtering as the operator types.
 */
class BreedDropdownOptionsTest {

    private val dogs = listOf(
        "Affenpinscher", "Afghan Hound", "Airedale Terrier", "Akita",
        "Labrador Retriever", "Lagotto Romagnolo", "Poodle",
    )

    @Test
    fun `blank query shows the catalog head so the bank is visible without typing`() {
        val options = breedDropdownOptions("", dogs, limit = 4)
        assertEquals(listOf("Affenpinscher", "Afghan Hound", "Airedale Terrier", "Akita"), options)
    }

    @Test
    fun `blank query never returns more than the limit`() {
        assertTrue(breedDropdownOptions("   ", dogs, limit = 3).size <= 3)
    }

    @Test
    fun `typed query filters to starts-with first`() {
        val options = breedDropdownOptions("la", dogs, limit = 8)
        assertEquals(listOf("Labrador Retriever", "Lagotto Romagnolo"), options)
    }

    @Test
    fun `empty catalog yields no options even when blank`() {
        assertTrue(breedDropdownOptions("", emptyList(), limit = 8).isEmpty())
    }
}
