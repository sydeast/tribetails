package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.InvoiceLineItem
import com.tribetails.auntieos.web.data.UninvoicedSession
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1178: the desktop composer's state, without Compose. Visit ticking, extra
 * lines, totals, terms to due date, and the request the dialog hands to
 * `createInvoice` / `createQuote`.
 */
class InvoiceComposerTest {

    private val walk = UninvoicedSession("s1", "kf1", "Dog walk", 30.0, "2026-10-02T15:00:00.000Z", 2500L)
    private val sit = UninvoicedSession("s2", "kf1", "Drop-in", 20.0, "2026-10-09T09:00:00.000Z", 1800L)
    private val unpriced = UninvoicedSession("s3", "kf1", "Overnight", 600.0, "2026-10-05T20:00:00.000Z", null)
    private val all = listOf(walk, sit, unpriced)

    // ── visit ticking ────────────────────────────────────────────────────────

    @Test
    fun tickedVisitsBecomeBoundLinesCarryingTheirSessionId() {
        val out = buildBoundLines(all, setOf("s1", "s2"), emptyMap())
        assertNull(out.error)
        assertEquals(
            listOf(
                InvoiceLineItem("Dog walk, 2026-10-02", 1.0, 2500L, sessionId = "s1"),
                InvoiceLineItem("Drop-in, 2026-10-09", 1.0, 1800L, sessionId = "s2"),
            ),
            out.lines,
        )
    }

    @Test
    fun untickedVisitsAreNotBilled() {
        val out = buildBoundLines(all, setOf("s2"), emptyMap())
        assertEquals(listOf("s2"), out.lines.map { it.sessionId })
    }

    @Test
    fun anUnpricedVisitRefusesUntilAPriceIsTyped() {
        val refused = buildBoundLines(all, setOf("s3"), emptyMap())
        assertEquals("Overnight, 2026-10-05 has no rate on file. Type what it should cost, or untick it.", refused.error)
        assertTrue(refused.lines.isEmpty())

        val typo = buildBoundLines(all, setOf("s3"), mapOf("s3" to "12.345"))
        assertEquals("The price for Overnight, 2026-10-05 needs a dollar amount, for example 25.00.", typo.error)

        val priced = buildBoundLines(all, setOf("s3"), mapOf("s3" to "$1,200.00"))
        assertNull(priced.error)
        assertEquals(120000L, priced.lines.single().unitCents)
    }

    @Test
    fun anUnpricedVisitThatIsUntickedDoesNotBlock() {
        assertNull(buildBoundLines(all, setOf("s1"), emptyMap()).error)
    }

    // ── extra lines ──────────────────────────────────────────────────────────

    @Test
    fun extraLinesParseToCents() {
        val out = parseDraftLines(
            listOf(ComposerDraftLine("Mileage", "12.5", "0.70", ""), ComposerDraftLine("Key copy", "1", "6", "1.00")),
            "",
        )
        assertNull(out.error)
        assertEquals(
            listOf(
                InvoiceLineItem("Mileage", 12.5, 70L),
                InvoiceLineItem("Key copy", 1.0, 600L, discountCents = 100L),
            ),
            out.lines,
        )
    }

    @Test
    fun aBadExtraLineNamesItselfAndNothingIsSalvaged() {
        assertEquals("Line 2 needs a description.", parseDraftLines(listOf(ComposerDraftLine("A", "1", "5"), ComposerDraftLine()), "").error)
        val badPrice = parseDraftLines(listOf(ComposerDraftLine("Mileage", "1", "abc")), "")
        assertEquals("Unit price for \"Mileage\" needs a dollar amount, for example 25.00.", badPrice.error)
        assertNull(badPrice.lines)
        assertEquals(
            "Quantity for \"Mileage\" must be a number greater than zero.",
            parseDraftLines(listOf(ComposerDraftLine("Mileage", "0", "1")), "").error,
        )
        assertEquals(
            "Quantity for \"Mileage\" cannot be more than 999.",
            parseDraftLines(listOf(ComposerDraftLine("Mileage", "1000", "1")), "").error,
        )
    }

    // ── totals ───────────────────────────────────────────────────────────────

    @Test
    fun theTotalIsTheTickedVisitsPlusExtrasLessTheDiscount() {
        val money = composerMoney(
            sessions = all,
            selected = setOf("s1", "s2"),
            prices = emptyMap(),
            drafts = listOf(ComposerDraftLine("Mileage", "10", "0.50")),
            invoiceDiscountText = "3.00",
        )
        assertNull(money.error)
        // 25.00 + 18.00 + 5.00 - 3.00
        assertEquals(4500L, money.totalCents)
        assertEquals(300L, money.invoiceDiscountCents)
        assertEquals(listOf("s1", "s2", ""), money.lines!!.map { it.sessionId })
    }

    @Test
    fun aDiscountLargerThanTheSubtotalIsRefusedWithBothFigures() {
        val money = composerMoney(all, setOf("s1"), emptyMap(), emptyList(), "30")
        assertNull(money.lines)
        assertEquals("Invoice discount ($30.00) is larger than the subtotal ($25.00).", money.error)
    }

    @Test
    fun aLineDiscountLargerThanTheLineIsRefused() {
        val money = composerMoney(all, emptySet(), emptyMap(), listOf(ComposerDraftLine("Key", "1", "5", "6")), "")
        assertEquals("Discount for \"Key\" ($6.00) is larger than the line itself ($5.00).", money.error)
    }

    // ── what blocks the create button ───────────────────────────────────────

    private fun blocked(
        kinfolkId: String = "kf1",
        path: InvoiceCreatePath = InvoiceCreatePath.WORK,
        termsCode: InvoiceTermsCode = InvoiceTermsCode.DUE_ON_RECEIPT,
        date: String = "2026-10-20",
        customDueDate: String = "",
        selected: Set<String> = setOf("s1"),
        drafts: List<ComposerDraftLine> = emptyList(),
        totalText: String = "",
    ): String? {
        val due = resolveDueDate(termsCode, date, all.filter { it.sessionId in selected }.map { it.startTime }, "2026-10-20")
        val money = composerMoney(all, selected, emptyMap(), drafts, "")
        return composerBlockedReason(kinfolkId, path, termsCode, due, date, customDueDate, selected.size, drafts.size, money, totalText)
    }

    @Test
    fun blockedReasons() {
        assertNull(blocked())
        assertEquals("Pick a household first.", blocked(kinfolkId = ""))
        assertEquals("Tick the work this invoice covers, or add a line of your own.", blocked(selected = emptySet()))
        assertNull(blocked(selected = emptySet(), drafts = listOf(ComposerDraftLine("Mileage", "1", "4"))))
        assertEquals("Date must be a real YYYY-MM-DD date", blocked(date = "2026-13-01"))
        assertEquals("Due date must be a real YYYY-MM-DD date", blocked(termsCode = InvoiceTermsCode.CUSTOM, customDueDate = "soon"))
        assertNull(blocked(termsCode = InvoiceTermsCode.CUSTOM, customDueDate = "2026-11-01"))
        assertTrue(blocked(selected = setOf("s3"))!!.contains("has no rate on file"))
        assertTrue(
            blocked(termsCode = InvoiceTermsCode.NET_7_AFTER_LAST_VISIT, selected = emptySet(), drafts = listOf(ComposerDraftLine("M", "1", "4")))!!
                .startsWith("These terms count from the last visit"),
        )
        val badTotal = "Total must be a dollar amount of zero or more, for example 120.00"
        assertEquals(badTotal, blocked(path = InvoiceCreatePath.BLANK, totalText = ""))
        // Never sent as a number the server cannot store, nor a fraction of a cent.
        for (bad in listOf("NaN", "1e5", "-5", "12.345", "Infinity")) {
            assertEquals(badTotal, blocked(path = InvoiceCreatePath.BLANK, totalText = bad), bad)
        }
        assertNull(blocked(path = InvoiceCreatePath.BLANK, totalText = "40"))
        assertNull(blocked(path = InvoiceCreatePath.BLANK, totalText = "$1,250.50"))
    }

    @Test
    fun theCreateButtonCountsTheVisits() {
        assertEquals("Create invoice", composerCreateLabel(false, 0))
        assertEquals("Create invoice for 1 visit", composerCreateLabel(false, 1))
        assertEquals("Create quote for 3 visits", composerCreateLabel(true, 3))
    }

    @Test
    fun theDoNotInvoiceWordsFollowTheSelection() {
        assertEquals("Do not invoice", doNotInvoiceLabel(0))
        assertEquals("Do not invoice this visit", doNotInvoiceLabel(1))
        assertEquals("Do not invoice these 2 visits", doNotInvoiceLabel(2))
        assertEquals("1 visit is marked do not invoice, and off this list until you put it back.", exclusionNotice(1, true))
        assertEquals("2 visits are back in this household's un-invoiced work.", exclusionNotice(2, false))
    }

    @Test
    fun theScopeLineSaysHowMuchIsTicked() {
        assertEquals(
            "2 of 3 un-invoiced visits selected for Ada Wren.",
            uninvoicedScopeLine("Ada Wren", 3, 2, 40, null, null),
        )
        assertEquals(
            "No un-invoiced completed visits for Ada Wren between 2026-09-01 and 2026-09-30. 12 visits were checked.",
            uninvoicedScopeLine("Ada Wren", 0, 0, 12, "2026-09-01", "2026-09-30"),
        )
    }

    // ── the request ──────────────────────────────────────────────────────────

    private fun request(
        isQuote: Boolean = false,
        path: InvoiceCreatePath = InvoiceCreatePath.WORK,
        termsCode: InvoiceTermsCode = InvoiceTermsCode.NET_7_AFTER_LAST_VISIT,
        selected: Set<String> = setOf("s1", "s2"),
        customDueDate: String = "",
        totalText: String = "",
        sendToKinfolk: Boolean = false,
    ): NewInvoiceBuild {
        val date = "2026-10-20"
        val due = resolveDueDate(
            termsCode,
            date,
            if (path == InvoiceCreatePath.WORK) all.filter { it.sessionId in selected }.map { it.startTime } else emptyList(),
            "2026-10-20",
        )
        val money = if (path == InvoiceCreatePath.WORK) composerMoney(all, selected, emptyMap(), emptyList(), "") else null
        return buildNewInvoiceRequest(
            isQuote, "kf1", "Ada Wren", path, date, termsCode, due, customDueDate, money, totalText, sendToKinfolk,
        )
    }

    @Test
    fun theWorkPathRequestIsADraftWithServerNumberedLinesAndComputedDueDate() {
        val r = assertNotNull(request().request)
        assertEquals(false, r.isQuote)
        assertEquals("draft", r.invoice.status)
        assertEquals("", r.invoice.invoiceNumber, "the server assigns the number")
        assertEquals("Ada Wren", r.invoice.client)
        assertEquals("kf1", r.invoice.kinfolkId)
        assertEquals("2026-10-20", r.invoice.date)
        // Last ticked visit 2026-10-09, plus 7.
        assertEquals("2026-10-16", r.invoice.dueDate)
        assertEquals("net_7_after_last_visit", r.termsCode)
        assertEquals(43.0, r.invoice.total)
        assertEquals(43.0, r.invoice.amountDue)
        assertEquals(listOf("s1", "s2"), r.invoice.sessionIds)
        assertEquals(listOf("s1", "s2"), r.lineItems!!.map { it.sessionId })
        assertEquals(0L, r.invoiceDiscountCents)
        assertEquals(false, r.sendToKinfolk)
    }

    @Test
    fun untickingAVisitMovesTheDueDateAndTheTotal() {
        val r = assertNotNull(request(selected = setOf("s1")).request)
        assertEquals("2026-10-09", r.invoice.dueDate)
        assertEquals(25.0, r.invoice.total)
        assertEquals(listOf("s1"), r.invoice.sessionIds)
    }

    @Test
    fun customTermsSendTheTypedDueDate() {
        val r = assertNotNull(request(termsCode = InvoiceTermsCode.CUSTOM, customDueDate = "2026-11-30").request)
        assertEquals("2026-11-30", r.invoice.dueDate)
        assertEquals("custom", r.termsCode)
    }

    @Test
    fun aQuoteLeavesStatusToTheServerAndCarriesTheSendFlag() {
        val r = assertNotNull(request(isQuote = true, sendToKinfolk = true).request)
        assertEquals(true, r.isQuote)
        assertEquals("", r.invoice.status)
        assertEquals(true, r.sendToKinfolk)
    }

    @Test
    fun anInvoiceNeverCarriesTheQuoteSendFlag() {
        assertEquals(false, request(isQuote = false, sendToKinfolk = true).request!!.sendToKinfolk)
    }

    @Test
    fun theBlankPathSendsNoLineItemsAtAll() {
        val r = assertNotNull(
            request(path = InvoiceCreatePath.BLANK, termsCode = InvoiceTermsCode.NET_14, selected = emptySet(), totalText = "40").request,
        )
        assertNull(r.lineItems)
        assertNull(r.invoiceDiscountCents)
        assertEquals(40.0, r.invoice.total)
        assertEquals(40.0, r.invoice.amountDue)
        assertEquals("2026-11-03", r.invoice.dueDate)
        assertTrue(r.invoice.sessionIds.isEmpty())
    }

    @Test
    fun theWorkPathWithNothingOnItBuildsNoRequest() {
        val out = request(selected = emptySet(), termsCode = InvoiceTermsCode.NET_7)
        assertNull(out.request)
        assertEquals("This invoice has no work on it yet.", out.error)
    }

    @Test
    fun moneyParsingNeverFallsBackToZero() {
        assertEquals(1250L, parseDollarsToCents("12.50"))
        assertEquals(125000L, parseDollarsToCents("$1,250"))
        assertNull(parseDollarsToCents(""))
        assertNull(parseDollarsToCents("12.345"))
        assertNull(parseDollarsToCents("-5"))
        assertNull(parseQty("0"))
        assertEquals(2.5, parseQty("2.5"))
    }
}
