package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreRest
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1199: the desktop invoice detail reads the stored stamp for its badge, never
 * `amountDue`, and renders the stored line items with bound lines marked.
 * Invoices are decoded through the desktop REST codec, the way the list stream
 * reads them, so the raw `lineItems` field is exercised as it arrives.
 */
class InvoiceDetailStatusTest {

    private val today = "2026-10-30"

    private fun decode(json: String): Invoice = JvmFirestoreRest.codec.decodeFromString(Invoice.serializer(), json)

    private fun inv(status: String, amountDue: Double, dueDate: String = "2026-11-15") =
        Invoice(_id = "i1", status = status, amountDue = amountDue, total = 40.0, dueDate = dueDate)

    // ── Badge ────────────────────────────────────────────────────────────────

    @Test
    fun theIssueShapesReadTheirStampNotTheirBalance() {
        // The old resolver: amountDue <= 0 -> PAID, else OUTSTANDING.
        assertEquals("CREDIT", invoiceDetailBadgeFor(inv("credit", amountDue = 0.0), today).label)
        assertEquals("DRAFT", invoiceDetailBadgeFor(inv("draft", amountDue = 40.0), today).label)
        assertEquals("QUOTE", invoiceDetailBadgeFor(inv("quote", amountDue = 40.0), today).label)
        assertEquals("CANCELLED", invoiceDetailBadgeFor(inv("cancelled", amountDue = 0.0), today).label)
        assertEquals("ZERO", invoiceDetailBadgeFor(inv("zero", amountDue = 0.0), today).label)
        assertEquals("REDEEMED", invoiceDetailBadgeFor(inv("redeemed", amountDue = 0.0), today).label)
        // A stamped open bill with a zero balance is still outstanding, and a
        // paid stamp is paid whatever the balance field says.
        assertEquals("OUTSTANDING", invoiceDetailBadgeFor(inv("open", amountDue = 0.0), today).label)
        assertEquals("PAID", invoiceDetailBadgeFor(inv("paid", amountDue = 90.0), today).label)
    }

    @Test
    fun everyStateHasItsOwnPillToneAndTrend() {
        val expected = mapOf(
            "open" to Triple("OUTSTANDING", AuntieStatusTone.Warning, "due 2026-11-15"),
            "paid" to Triple("PAID", AuntieStatusTone.Success, "paid in full"),
            "draft" to Triple("DRAFT", AuntieStatusTone.Muted, "not sent yet"),
            "quote" to Triple("QUOTE", AuntieStatusTone.Purple, "quoted, not billed"),
            "cancelled" to Triple("CANCELLED", AuntieStatusTone.Muted, "cancelled"),
            "credit" to Triple("CREDIT", AuntieStatusTone.Teal, "credit owed to the household"),
            "redeemed" to Triple("REDEEMED", AuntieStatusTone.Muted, "credit redeemed"),
            "zero" to Triple("ZERO", AuntieStatusTone.Muted, "nothing billed"),
        )
        for ((status, triple) in expected) {
            val b = invoiceDetailBadgeFor(inv(status, amountDue = 40.0), today)
            assertEquals(triple.first, b.label, status)
            assertEquals(triple.second, b.tone, status)
            assertEquals(triple.third, b.amountTrend, status)
            assertFalse(b.overdue, status)
        }
        assertEquals(InvoiceState.entries.size, expected.size)
    }

    @Test
    fun overdueOutranksOnlyAnOpenStamp() {
        val open = invoiceDetailBadgeFor(inv("open", amountDue = 40.0, dueDate = "2026-10-01"), today)
        assertTrue(open.overdue)
        assertEquals("OVERDUE", open.label)
        assertEquals(AuntieStatusTone.Error, open.tone)
        assertEquals("past due 2026-10-01", open.amountTrend)
        assertEquals(InvoiceState.OPEN, open.state)
        val quote = invoiceDetailBadgeFor(inv("quote", amountDue = 40.0, dueDate = "2026-10-01"), today)
        assertFalse(quote.overdue)
        assertEquals("QUOTE", quote.label)
    }

    @Test
    fun anOpenBillWithNoDueDateIsDueSoon() {
        assertEquals("due soon", invoiceDetailBadgeFor(inv("open", amountDue = 40.0, dueDate = ""), today).amountTrend)
    }

    @Test
    fun anUnstampedDocShowsItsOwnWordAndNoGuess() {
        val sent = invoiceDetailBadgeFor(inv(" sent ", amountDue = 0.0), today)
        assertNull(sent.state)
        assertEquals("SENT", sent.label)
        assertEquals("sent", sent.amountTrend)
        val blank = invoiceDetailBadgeFor(inv("", amountDue = 0.0), today)
        assertEquals("NO STATUS", blank.label)
        assertEquals("no status on record", blank.amountTrend)
    }

    // ── Line items panel ─────────────────────────────────────────────────────

    @Test
    fun neverItemizedIsASentenceNotAnEmptyTable() {
        val panel = invoiceDetailLinesPanelOf(decode("""{"_id":"i2","status":"open","total":40.0}"""))
        assertEquals(InvoiceDetailLinesPanel.NotItemized, panel)
        assertEquals("No itemized breakdown. This invoice's total was entered directly.", invoiceDetailLinesEmptyCopy(panel))
    }

    @Test
    fun anEmptyBreakdownSaysSo() {
        val panel = invoiceDetailLinesPanelOf(decode("""{"_id":"i3","status":"zero","lineItems":[]}"""))
        assertEquals(InvoiceDetailLinesPanel.ItemizedEmpty, panel)
        assertEquals("Itemized as billing nothing: there is a breakdown, and it is empty.", invoiceDetailLinesEmptyCopy(panel))
    }

    @Test
    fun aValueThatIsNotAListReadsAsNotItemized() {
        assertEquals(
            InvoiceDetailLinesPanel.NotItemized,
            invoiceDetailLinesPanelOf(decode("""{"_id":"i4","status":"open","lineItems":"oops"}""")),
        )
    }

    @Test
    fun storedLinesRenderWithBoundVisitsMarkedAndTotalsFromTheLines() {
        val invoice = decode(
            """
            {"_id":"inv1","status":"open","total":55.0,"amountDue":55.0,
             "lineItems":[
               {"description":"Dog walk","qty":2,"unitCents":2500,"sessionId":"s1"},
               {"description":"Mileage","qty":1.5,"unitCents":1000,"discountCents":500},
               {"description":"","qty":1,"unitCents":500}
             ],
             "invoiceDiscountCents":500}
            """.trimIndent(),
        )
        val panel = assertIs<InvoiceDetailLinesPanel.Lines>(invoiceDetailLinesPanelOf(invoice))
        assertNull(invoiceDetailLinesEmptyCopy(panel))
        assertEquals(3, panel.rows.size)

        val walk = panel.rows[0]
        assertEquals("Dog walk", walk.description)
        assertEquals("2 x $25.00", walk.detail)
        assertEquals(5000L, walk.amountCents)
        assertEquals("s1", walk.boundSessionId)

        val mileage = panel.rows[1]
        assertEquals("1.5 x $10.00, less $5.00", mileage.detail)
        assertEquals(1000L, mileage.amountCents)
        assertNull(mileage.boundSessionId)

        val lost = panel.rows[2]
        assertTrue(lost.descriptionMissing)
        assertEquals("no description", lost.description)

        assertEquals(6500L, panel.subtotalCents)
        assertEquals(500L, panel.invoiceDiscountCents)
        assertEquals(6000L, panel.totalCents)
    }

    @Test
    fun aBlankSessionIdIsATypedLine() {
        val invoice = decode(
            """{"_id":"i5","status":"open","lineItems":[{"description":"Bath","qty":1,"unitCents":3000,"sessionId":"  "}]}""",
        )
        val panel = assertIs<InvoiceDetailLinesPanel.Lines>(invoiceDetailLinesPanelOf(invoice))
        assertNull(panel.rows.single().boundSessionId)
        assertEquals(0L, panel.invoiceDiscountCents)
        assertEquals(3000L, panel.totalCents)
    }
}
