package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertFalse

/** Kinfolk facet (spec 16.2): household derivation + predicate. */
class InvoiceFacetTest {

    private fun inv(id: String, kinfolkId: String, name: String) =
        Invoice(_id = id, kinfolkId = kinfolkId, kinfolkName = name)

    @Test
    fun derivesDistinctHouseholdsNameSortedAfterAll() {
        val invoices = listOf(
            inv("i1", "kf2", "Thorne"),
            inv("i2", "kf1", "Halbrook"),
            inv("i3", "kf2", "Thorne"), // dup household
            inv("i4", "", "blank kinfolkId is skipped"),
        )
        val facets = householdFacets(invoices)
        assertEquals(ALL_HOUSEHOLDS, facets.first())
        assertEquals(listOf("All households", "Halbrook", "Thorne"), facets.map { it.name })
    }

    @Test
    fun allHouseholdsMatchesEverything() {
        val i = inv("i1", "kf1", "Halbrook")
        assertTrue(matchesHouseholdFacet(i, ALL_HOUSEHOLDS))
    }

    @Test
    fun pickedHouseholdPinsToThatKinfolk() {
        val a = inv("i1", "kf1", "Halbrook")
        val b = inv("i2", "kf2", "Thorne")
        val facet = HouseholdFacet("kf1", "Halbrook")
        assertTrue(matchesHouseholdFacet(a, facet))
        assertFalse(matchesHouseholdFacet(b, facet))
    }
}
