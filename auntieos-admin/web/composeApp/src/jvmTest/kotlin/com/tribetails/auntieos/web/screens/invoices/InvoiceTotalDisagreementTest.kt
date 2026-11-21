package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreRest
import kotlinx.serialization.builtins.ListSerializer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1239: the desktop invoice detail says when the stored total disagrees with
 * the line items, naming both figures and reconciling neither. `totalCents`
 * wins over the dollar `total` whenever it is readable, and a bad
 * `totalCents` never drops the invoice from the list. Decoded through the
 * desktop REST codec, the way the invoices stream reads them.
 */
class InvoiceTotalDisagreementTest {

    private fun decode(json: String): Invoice = JvmFirestoreRest.codec.decodeFromString(Invoice.serializer(), json)

    /** Two lines: 2 x $15.00 and 1 x $10.00 less $2.00, so $38.00 before any invoice discount. */
    private val lines = """[
        {"description":"Walk","qty":2,"unitCents":1500},
        {"description":"Feed","qty":1,"unitCents":1000,"discountCents":200}
    ]"""

    private fun inv(extra: String) = decode("""{"_id":"i1","status":"open","lineItems":$lines,$extra}""")

    @Test
    fun aBadTotalCentsNeverDropsTheInvoiceFromTheList() {
        val list = JvmFirestoreRest.codec.decodeFromString(
            ListSerializer(Invoice.serializer()),
            """[
              {"_id":"a","totalCents":"3800"},
              {"_id":"b","totalCents":null},
              {"_id":"c","totalCents":{"x":1}},
              {"_id":"d","totalCents":12.5}
            ]""",
        )
        assertEquals(listOf("a", "b", "c", "d"), list.map { it._id })
    }

    @Test
    fun anUnitemizedInvoiceHasNothingToDisagreeWith() {
        assertNull(invoiceTotalDisagreementOf(decode("""{"_id":"i1","total":99.0,"totalCents":9900}""")))
    }

    @Test
    fun agreeingFiguresRaiseNothing() {
        assertNull(invoiceTotalDisagreementOf(inv(""""totalCents":3800,"total":38.0""")))
        assertNull(invoiceTotalDisagreementOf(inv(""""total":38.0""")))
        assertNull(invoiceTotalDisagreementOf(inv(""""invoiceDiscountCents":800,"totalCents":3000""")))
    }

    @Test
    fun totalCentsIsPreferredOverTheDollarTotal() {
        // The dollar field agrees, the exact field does not: the exact one is the claim.
        assertEquals(
            InvoiceTotalDisagreement(3800L, 4000L, InvoiceStoredTotalField.TOTAL_CENTS),
            invoiceTotalDisagreementOf(inv(""""totalCents":4000,"total":38.0""")),
        )
        // And the other way round: an exact agreement is not overruled by a stale dollar field.
        assertNull(invoiceTotalDisagreementOf(inv(""""totalCents":3800,"total":45.0""")))
        // A zero totalCents is still a readable claim (web keys on presence, not on non-zero).
        assertEquals(
            InvoiceTotalDisagreement(3800L, 0L, InvoiceStoredTotalField.TOTAL_CENTS),
            invoiceTotalDisagreementOf(inv(""""totalCents":0,"total":38.0""")),
        )
    }

    @Test
    fun anUnreadableTotalCentsFallsBackToTheDollarTotal() {
        assertEquals(
            InvoiceTotalDisagreement(3800L, 4500L, InvoiceStoredTotalField.TOTAL),
            invoiceTotalDisagreementOf(inv(""""totalCents":"3800","total":45.0""")),
        )
        assertEquals(
            InvoiceTotalDisagreement(3800L, 4500L, InvoiceStoredTotalField.TOTAL),
            invoiceTotalDisagreementOf(inv(""""totalCents":null,"total":45.0""")),
        )
    }

    @Test
    fun theDollarFallbackComparesInWholeCents() {
        // 40.10 * 100 is 4009.999... in floating point; it must not read as drift.
        val doc = decode(
            """{"_id":"i1","lineItems":[{"description":"x","qty":1,"unitCents":4010}],"total":40.1}""",
        )
        assertNull(invoiceTotalDisagreementOf(doc))
    }

    @Test
    fun anEmptyItemizationIsStillCompared() {
        val doc = decode("""{"_id":"i1","lineItems":[],"invoiceDiscountCents":500,"totalCents":0}""")
        assertEquals(InvoiceTotalDisagreement(-500L, 0L, InvoiceStoredTotalField.TOTAL_CENTS), invoiceTotalDisagreementOf(doc))
    }

    @Test
    fun theBannerNamesBothFiguresInPlainWords() {
        assertEquals("The line items do not add up to the total", INVOICE_TOTAL_DISAGREEMENT_TITLE)
        val editable = invoiceTotalDisagreementText(
            InvoiceTotalDisagreement(3800L, 4000L, InvoiceStoredTotalField.TOTAL_CENTS),
            linesEditable = true,
        )
        assertEquals(
            "The line items add up to \$38.00, but the invoice total is \$40.00. " +
                "The household is billed \$40.00. Nothing was changed to make them match. " +
                "If the line items are right, press Edit and save them, and the total will follow.",
            editable,
        )
    }
    /** #1860: a paid invoice's lines are locked, so the banner never asks for a re-save. */
    @Test
    fun aLockedInvoiceIsNeverToldToResaveItsLines() {
        val locked = invoiceTotalDisagreementText(
            InvoiceTotalDisagreement(0L, 6000L, InvoiceStoredTotalField.TOTAL),
            linesEditable = false,
        )
        assertTrue(locked.endsWith("A payment is recorded, so the line items can no longer be edited."))
        assertFalse(locked.contains("press Edit"))
        for (text in listOf(locked, invoiceTotalDisagreementText(InvoiceTotalDisagreement(0L, 6000L, InvoiceStoredTotalField.TOTAL), true))) {
            assertFalse(text.contains("legacy"))
            assertFalse(text.contains("stored"))
        }
    }
}
