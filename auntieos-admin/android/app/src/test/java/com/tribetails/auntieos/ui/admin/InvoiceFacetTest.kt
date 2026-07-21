package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Kinfolk facet (16.2) + kin/pet sub-line join (16.3) helpers. */
class InvoiceFacetTest {

    private fun inv(id: String, kinfolkId: String, name: String) =
        Invoice(id = id, kinfolkId = kinfolkId, kinfolkName = name)

    @Test
    fun derivesDistinctHouseholdsNameSortedAfterAll() {
        val invoices = listOf(
            inv("i1", "kf2", "Thorne"),
            inv("i2", "kf1", "Halbrook"),
            inv("i3", "kf2", "Thorne"),
            inv("i4", "", "skipped"),
        )
        val facets = householdFacets(invoices)
        assertEquals(ALL_HOUSEHOLDS, facets.first())
        assertEquals(listOf("All households", "Halbrook", "Thorne"), facets.map { it.name })
    }

    @Test
    fun facetPredicate() {
        val a = inv("i1", "kf1", "Halbrook")
        val b = inv("i2", "kf2", "Thorne")
        assertTrue(matchesHouseholdFacet(a, ALL_HOUSEHOLDS))
        assertTrue(matchesHouseholdFacet(a, HouseholdFacet("kf1", "Halbrook")))
        assertFalse(matchesHouseholdFacet(b, HouseholdFacet("kf1", "Halbrook")))
    }

    // PART B: a quote is an invoice in QUOTE status; the list marks it with a pill.
    @Test
    fun quoteClassifierMatchesQuoteStatusCaseInsensitively() {
        assertTrue(invoiceIsQuote(Invoice(id = "q1", status = "QUOTE")))
        assertTrue(invoiceIsQuote(Invoice(id = "q2", status = "quote")))
        assertFalse(invoiceIsQuote(Invoice(id = "i1", status = "draft")))
        assertFalse(invoiceIsQuote(Invoice(id = "i2", status = "sent")))
        assertFalse(invoiceIsQuote(Invoice(id = "i3", status = "")))
    }
}
