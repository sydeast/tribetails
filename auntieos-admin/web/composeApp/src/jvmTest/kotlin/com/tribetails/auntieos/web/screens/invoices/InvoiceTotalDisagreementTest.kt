package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreRest
import kotlinx.serialization.builtins.ListSerializer
import kotlin.test.Test
import kotlin.test.assertEquals
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
    fun theBannerNamesBothFiguresAndWhereTheStoredOneLives() {
        assertEquals("This invoice disagrees with itself", INVOICE_TOTAL_DISAGREEMENT_TITLE)
        val exact = invoiceTotalDisagreementText(InvoiceTotalDisagreement(3800L, 4000L, InvoiceStoredTotalField.TOTAL_CENTS))
        assertEquals(
            "The line items add up to \$38.00, but the total stored on the invoice says \$40.00. " +
                "Nothing has been changed to make them match, and nothing will be. " +
                "The household is billed the stored figure. Re-saving the line items through Edit will recompute " +
                "the stored total from them, if the lines are the version you want to keep.",
            exact,
        )
        val legacy = invoiceTotalDisagreementText(InvoiceTotalDisagreement(3800L, 4500L, InvoiceStoredTotalField.TOTAL))
        assertTrue(legacy.startsWith("The line items add up to \$38.00, but the total stored on the invoice (its legacy dollar field) says \$45.00."))
    }
}
