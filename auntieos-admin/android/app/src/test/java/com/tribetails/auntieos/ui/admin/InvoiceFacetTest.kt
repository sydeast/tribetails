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
/**
 * Task 5.1: the archive facet and the panel subtitle.
 *
 * Same package as `InvoicesScreen.kt` so the `internal` helpers are visible,
 * which is why `householdFacets` and friends are internal rather than private.
 */
class InvoiceArchiveFacetTest {
    private fun inv(id: String, archived: Boolean) =
        com.tribetails.auntieos.data.model.Invoice(id = id).apply {
            if (archived) archivedAt = "2026-07-25T00:00:00Z"
        }
    @org.junit.Test
    fun `Hide keeps only unarchived invoices`() {
        org.junit.Assert.assertTrue(archivedAllows(ArchivedMode.Hide, inv("a", archived = false)))
        org.junit.Assert.assertFalse(archivedAllows(ArchivedMode.Hide, inv("b", archived = true)))
    }
    @org.junit.Test
    fun `Only keeps just the archived ones`() {
        org.junit.Assert.assertFalse(archivedAllows(ArchivedMode.Only, inv("a", archived = false)))
        org.junit.Assert.assertTrue(archivedAllows(ArchivedMode.Only, inv("b", archived = true)))
    }
    @org.junit.Test
    fun `Include keeps everything`() {
        org.junit.Assert.assertTrue(archivedAllows(ArchivedMode.Include, inv("a", archived = false)))
        org.junit.Assert.assertTrue(archivedAllows(ArchivedMode.Include, inv("b", archived = true)))
    }
    @org.junit.Test
    fun `an explicit null archivedAt survives Hide, because unarchive writes null`() {
        val restored = com.tribetails.auntieos.data.model.Invoice(id = "r").apply { archivedAt = null }
        org.junit.Assert.assertTrue(archivedAllows(ArchivedMode.Hide, restored))
    }
    @org.junit.Test
    fun `the subtitle stays quiet when nothing is hidden`() {
        org.junit.Assert.assertEquals(
            "2 of 3 shown. Tap a row to open the invoice.",
            invoiceListSubtitle(visible = 2, inScope = 3, archivedHidden = 0),
        )
    }
    @org.junit.Test
    fun `the subtitle NAMES the hidden invoices and scopes the count to what is loaded`() {
        // Rows must never quietly disappear, and a bare number would read as a
        // fact about the books rather than about this page.
        val one = invoiceListSubtitle(visible = 1, inScope = 1, archivedHidden = 1)
        org.junit.Assert.assertTrue(one.contains("1 archived invoice hidden"))
        org.junit.Assert.assertTrue(one.contains("loaded here"))
        org.junit.Assert.assertTrue(
            invoiceListSubtitle(visible = 1, inScope = 1, archivedHidden = 3).contains("3 archived invoices hidden"),
        )
    }
}
