package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultSession
import com.tribetails.auntieos.data.model.InvoiceLineItem
import com.tribetails.auntieos.domain.InvoiceTermsCode
import com.tribetails.auntieos.domain.resolveDueDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Everything the #408 composer decides, asserted rather than eyeballed on a
 * device. Replaces `NewInvoiceValidationTest`, whose subject was the old plain
 * form: it pinned an invoice number as REQUIRED and an amount due as a typed
 * input, and both of those are exactly what the issue asked to be removed.
 */
class InvoiceComposerTest {

    private fun session(
        id: String,
        service: String = "Dog walk",
        start: String = "2026-08-11T15:00:00.000Z",
        unitCents: Long? = 2500L,
        minutes: Double = 30.0,
    ) = ListUninvoicedSessionsResultSession(
        sessionId = id,
        kinfolkId = "kf1",
        serviceType = service,
        durationMinutes = minutes,
        startTime = start,
        unitCents = unitCents,
    )

    // ── bound lines ───────────────────────────────────────────────────────────

    @Test
    fun `a ticked visit becomes a line bound to it`() {
        val out = buildBoundLines(listOf(session("s1")), setOf("s1"), emptyMap())
        assertNull(out.error)
        assertEquals(1, out.lines.size)
        val line = out.lines.first()
        assertEquals("Dog walk, 2026-08-11", line.description)
        assertEquals("s1", line.sessionId)
        assertEquals(2500L, line.unitCents)
        // ONE VISIT, not a duration. The rate card is priced per service, so
        // multiplying by the half hour would silently double the bill.
        assertEquals(1.0, line.qty, 0.0001)
    }

    @Test
    fun `an unticked visit contributes nothing`() {
        val out = buildBoundLines(listOf(session("s1"), session("s2")), setOf("s2"), emptyMap())
        assertEquals(listOf("s2"), out.lines.map { it.sessionId })
    }

    @Test
    fun `an unpriced visit refuses rather than billing zero`() {
        val out = buildBoundLines(listOf(session("s1", unitCents = null)), setOf("s1"), emptyMap())
        assertEquals(emptyList<InvoiceLineItem>(), out.lines)
        assertEquals("Dog walk, 2026-08-11 has no rate on file. Type what it should cost, or untick it.", out.error)
    }

    @Test
    fun `an unpriced visit takes the price the operator typed`() {
        val out = buildBoundLines(
            listOf(session("s1", unitCents = null)),
            setOf("s1"),
            mapOf("s1" to "18.75"),
        )
        assertNull(out.error)
        assertEquals(1875L, out.lines.single().unitCents)
    }

    @Test
    fun `a typed price that will not parse names the visit and the shape wanted`() {
        val out = buildBoundLines(listOf(session("s1", unitCents = null)), setOf("s1"), mapOf("s1" to "lots"))
        assertEquals("The price for Dog walk, 2026-08-11 needs a dollar amount, for example 25.00.", out.error)
    }

    @Test
    fun `a typed price above the schema cap is refused before the round trip`() {
        val out = buildBoundLines(
            listOf(session("s1", unitCents = null)),
            setOf("s1"),
            mapOf("s1" to "100000.01"),
        )
        assertNotNull(out.error)
        assertTrue(out.error!!.contains("cannot be more than $100000.00"))
    }

    @Test
    fun `a visit with no service name still reads as something`() {
        val out = buildBoundLines(listOf(session("s1", service = "  ")), setOf("s1"), emptyMap())
        assertEquals("Visit, 2026-08-11", out.lines.single().description)
    }

    // ── typed extra charges ───────────────────────────────────────────────────

    @Test
    fun `a typed charge becomes an ordinary unbound line`() {
        val out = parseDraftLines(
            listOf(ComposerDraftLine(description = "Mileage", qtyText = "12", unitText = "0.70")),
            "",
        )
        assertNull(out.error)
        val line = out.lines!!.single()
        assertEquals("Mileage", line.description)
        assertEquals(12.0, line.qty, 0.0001)
        assertEquals(70L, line.unitCents)
        assertEquals("", line.sessionId)
    }

    @Test
    fun `a row is never partially salvaged`() {
        val out = parseDraftLines(
            listOf(
                ComposerDraftLine(description = "Mileage", qtyText = "12", unitText = "0.70"),
                ComposerDraftLine(description = "Keys cut", qtyText = "1", unitText = "nope"),
            ),
            "",
        )
        // Dropping the bad row would quietly bill less than was entered, and
        // submitting it as 0 would bill nothing for it.
        assertNull(out.lines)
        assertEquals("Unit price for \"Keys cut\" needs a dollar amount, for example 25.00.", out.error)
    }

    @Test
    fun `a row with no description is named by its position`() {
        val out = parseDraftLines(listOf(ComposerDraftLine(qtyText = "1", unitText = "5")), "")
        assertEquals("Line 1 needs a description.", out.error)
    }

    @Test
    fun `a blank whole-invoice discount is no discount, not an unreadable one`() {
        val out = parseDraftLines(listOf(ComposerDraftLine("Mileage", "1", "5.00")), "   ")
        assertNull(out.error)
        assertEquals(0L, out.invoiceDiscountCents)
    }

    @Test
    fun `an unreadable whole-invoice discount is refused`() {
        val out = parseDraftLines(listOf(ComposerDraftLine("Mileage", "1", "5.00")), "some")
        assertEquals("Invoice discount needs a dollar amount, or leave it empty.", out.error)
    }

    @Test
    fun `a quantity above the schema cap is refused`() {
        val out = parseDraftLines(listOf(ComposerDraftLine("Mileage", "1000", "1.00")), "")
        assertEquals("Quantity for \"Mileage\" cannot be more than 999.", out.error)
    }

    // ── money validation ──────────────────────────────────────────────────────

    @Test
    fun `a line discount larger than the line names both figures`() {
        val error = validateComposerMoney(
            listOf(InvoiceLineItem(description = "Mileage", qty = 1.0, unitCents = 500L, discountCents = 900L)),
            0L,
        )
        assertEquals("Discount for \"Mileage\" ($9.00) is larger than the line itself ($5.00).", error)
    }

    @Test
    fun `an invoice discount larger than the subtotal names both figures`() {
        val error = validateComposerMoney(
            listOf(InvoiceLineItem(description = "Mileage", qty = 1.0, unitCents = 500L)),
            900L,
        )
        assertEquals("Invoice discount ($9.00) is larger than the subtotal ($5.00).", error)
    }

    @Test
    fun `sound money passes`() {
        assertNull(
            validateComposerMoney(
                listOf(InvoiceLineItem(description = "Mileage", qty = 2.0, unitCents = 500L, discountCents = 100L)),
                200L,
            ),
        )
    }

    // ── the whole work path's money ───────────────────────────────────────────

    @Test
    fun `the total is the visits plus the typed charges, less the invoice discount`() {
        val money = composerMoney(
            sessions = listOf(session("s1", unitCents = 2500L), session("s2", unitCents = 3000L)),
            selected = setOf("s1", "s2"),
            prices = emptyMap(),
            drafts = listOf(ComposerDraftLine("Mileage", "10", "0.70")),
            invoiceDiscountText = "5.00",
        )
        assertNull(money.error)
        assertEquals(3, money.lines!!.size)
        // 2500 + 3000 + 700 - 500
        assertEquals(5700L, money.totalCents)
        assertEquals(500L, money.invoiceDiscountCents)
    }

    @Test
    fun `one unreadable figure sinks the whole set rather than half of it`() {
        val money = composerMoney(
            sessions = listOf(session("s1", unitCents = null)),
            selected = setOf("s1"),
            prices = emptyMap(),
            drafts = emptyList(),
            invoiceDiscountText = "",
        )
        assertNull(money.lines)
        assertNotNull(money.error)
    }

    // ── the blank path ────────────────────────────────────────────────────────

    @Test
    fun `the blank path still needs a household and a total`() {
        assertEquals(
            "Pick a household for this invoice",
            validateBlankInvoice(kinfolkId = "", totalText = "100", date = "", dueDate = ""),
        )
        assertEquals(
            "Total must be zero or greater",
            validateBlankInvoice(kinfolkId = "kf1", totalText = "", date = "", dueDate = ""),
        )
        assertEquals(
            "Total must be zero or greater",
            validateBlankInvoice(kinfolkId = "kf1", totalText = "-5", date = "", dueDate = ""),
        )
        assertEquals(
            "Total must be zero or greater",
            validateBlankInvoice(kinfolkId = "kf1", totalText = "abc", date = "", dueDate = ""),
        )
        assertNull(validateBlankInvoice(kinfolkId = "kf1", totalText = "0", date = "", dueDate = ""))
    }

    @Test
    fun `the blank path refuses an impossible date on either field`() {
        assertEquals(
            "Date must be a real YYYY-MM-DD date",
            validateBlankInvoice("kf1", "100", "2026-13-01", ""),
        )
        assertEquals(
            "Due date must be a real YYYY-MM-DD date",
            validateBlankInvoice("kf1", "100", "", "2026-02-30"),
        )
    }

    @Test
    fun `the composer no longer has an invoice number to require`() {
        // The rule this replaced was `invoiceNumber.isBlank() -> "Invoice number
        // is required"`. The server mints it from a transactional counter, so
        // there is nothing to type and nothing to refuse.
        assertNull(validateBlankInvoice(kinfolkId = "kf1", totalText = "100", date = "", dueDate = ""))
    }

    // ── what blocks the create button, and what it says ───────────────────────

    private fun blocked(
        kinfolkId: String = "kf1",
        path: InvoiceCreatePath = InvoiceCreatePath.WORK,
        termsCode: InvoiceTermsCode = InvoiceTermsCode.DUE_ON_RECEIPT,
        date: String = "2026-08-19",
        serviceDates: List<String> = listOf("2026-08-11"),
        customDueDate: String = "",
        selectedCount: Int = 1,
        draftCount: Int = 0,
        money: ComposerMoney? = ComposerMoney(
            lines = listOf(InvoiceLineItem("Dog walk", 1.0, 2500L)),
            invoiceDiscountCents = 0L,
            totalCents = 2500L,
            error = null,
        ),
        totalText: String = "",
    ) = composerBlockedReason(
        kinfolkId = kinfolkId,
        path = path,
        termsCode = termsCode,
        due = resolveDueDate(termsCode, date, serviceDates, "2026-08-19"),
        date = date,
        customDueDate = customDueDate,
        selectedCount = selectedCount,
        draftCount = draftCount,
        money = money,
        totalText = totalText,
    )

    @Test
    fun `nothing blocks a household with ticked, priced work`() {
        assertNull(blocked())
    }

    @Test
    fun `no household is the first thing said`() {
        assertEquals("Pick a household first.", blocked(kinfolkId = ""))
    }

    @Test
    fun `service-relative terms with nothing ticked say what is missing`() {
        val reason = blocked(
            termsCode = InvoiceTermsCode.NET_14_AFTER_LAST_VISIT,
            serviceDates = emptyList(),
            selectedCount = 0,
            money = ComposerMoney(emptyList(), 0L, 0L, null),
        )
        assertNotNull(reason)
        assertTrue(reason!!.contains("no visits on this invoice yet"))
    }

    @Test
    fun `an empty selection with no typed lines asks for one or the other`() {
        assertEquals(
            "Tick the work this invoice covers, or add a line of your own.",
            blocked(selectedCount = 0, draftCount = 0, money = ComposerMoney(emptyList(), 0L, 0L, null)),
        )
    }

    @Test
    fun `a money problem is stated verbatim rather than summarised`() {
        assertEquals(
            "Dog walk has no rate on file. Type what it should cost, or untick it.",
            blocked(money = ComposerMoney(null, 0L, 0L, "Dog walk has no rate on file. Type what it should cost, or untick it.")),
        )
    }

    @Test
    fun `custom terms let the operator through without a resolved date`() {
        assertNull(blocked(termsCode = InvoiceTermsCode.CUSTOM, customDueDate = "2026-09-01"))
        assertEquals(
            "Due date must be a real YYYY-MM-DD date",
            blocked(termsCode = InvoiceTermsCode.CUSTOM, customDueDate = "2026-02-30"),
        )
    }

    @Test
    fun `an impossible invoice date is named as such`() {
        assertEquals("Date must be a real YYYY-MM-DD date", blocked(date = "2026-13-01"))
    }

    @Test
    fun `the blank path is blocked by its own total`() {
        assertEquals(
            "Total must be zero or greater",
            blocked(path = InvoiceCreatePath.BLANK, money = null, totalText = ""),
        )
        assertNull(blocked(path = InvoiceCreatePath.BLANK, money = null, totalText = "40"))
    }

    // ── the words on the screen ───────────────────────────────────────────────

    @Test
    fun `the create button counts what it is about to bill for`() {
        assertEquals("Create invoice for 4 visits", composerCreateLabel(InvoiceCreateKind.INVOICE, 4))
        assertEquals("Create invoice for 1 visit", composerCreateLabel(InvoiceCreateKind.INVOICE, 1))
        assertEquals("Create invoice", composerCreateLabel(InvoiceCreateKind.INVOICE, 0))
        assertEquals("Create quote for 2 visits", composerCreateLabel(InvoiceCreateKind.QUOTE, 2))
    }

    @Test
    fun `the terms note says where the date came from and never moves a past one`() {
        val past = resolveDueDate(
            InvoiceTermsCode.DUE_ON_LAST_VISIT,
            "2026-08-19",
            listOf("2026-08-11"),
            "2026-08-19",
        )
        val note = composerTermsNote(InvoiceTermsCode.DUE_ON_LAST_VISIT, past, "2026-08-19")
        assertTrue(note.contains("counting from 2026-08-11"))
        assertTrue(note.contains("already"))
        assertTrue(note.contains("overdue the moment it goes out"))
    }

    @Test
    fun `custom terms say the due date is the operator's`() {
        val due = resolveDueDate(InvoiceTermsCode.CUSTOM, "2026-08-19", emptyList(), "2026-08-19")
        assertEquals(
            "These terms leave the due date to you.",
            composerTermsNote(InvoiceTermsCode.CUSTOM, due, "2026-08-19"),
        )
    }

    @Test
    fun `an empty queue names the household, the range and what was checked`() {
        assertEquals(
            "No un-invoiced completed visits for the Halbrooks. 41 visits were checked.",
            uninvoicedScopeLine("the Halbrooks", total = 0, selectedCount = 0, scanned = 41L, narrowedFrom = null, narrowedTo = null),
        )
        assertEquals(
            "No un-invoiced completed visits for the Halbrooks between 2026-07-01 and 2026-07-31. " +
                "9 visits were checked.",
            uninvoicedScopeLine("the Halbrooks", 0, 0, 9L, "2026-07-01", "2026-07-31"),
        )
    }

    @Test
    fun `a loaded queue says how much of it is ticked`() {
        assertEquals(
            "3 of 5 un-invoiced visits selected for the Halbrooks.",
            uninvoicedScopeLine("the Halbrooks", total = 5, selectedCount = 3, scanned = 5L, narrowedFrom = null, narrowedTo = null),
        )
        assertEquals(
            "1 of 1 un-invoiced visit selected for the Halbrooks.",
            uninvoicedScopeLine("the Halbrooks", 1, 1, 1L, null, null),
        )
    }

    @Test
    fun `do not invoice keeps its verb when nothing is ticked`() {
        assertEquals("Do not invoice", doNotInvoiceLabel(0))
        assertEquals("Do not invoice this visit", doNotInvoiceLabel(1))
        assertEquals("Do not invoice these 3 visits", doNotInvoiceLabel(3))
    }

    @Test
    fun `the exclusion confirmation counts what actually changed`() {
        assertEquals(
            "1 visit is marked do not invoice, and off this list until you put it back.",
            exclusionNotice(1, doNotInvoice = true),
        )
        assertEquals(
            "3 visits are marked do not invoice, and off this list until you put them back.",
            exclusionNotice(3, doNotInvoice = true),
        )
        assertEquals(
            "2 visits are back in this household's un-invoiced work.",
            exclusionNotice(2, doNotInvoice = false),
        )
    }

    @Test
    fun `excluded work says why it is not on the list above`() {
        assertEquals(
            "1 completed visit is marked do not invoice, so it is not on the list above.",
            excludedWorkLine(1),
        )
        assertEquals(
            "4 completed visits are marked do not invoice, so they are not on the list above.",
            excludedWorkLine(4),
        )
    }

    @Test
    fun `a visit day reads as a day, and carries its year only when it is not this one`() {
        assertEquals("Aug 11", visitDayLabel("2026-08-11T15:00:00.000Z", "2026-08-19"))
        assertEquals("Aug 11, 2025", visitDayLabel("2025-08-11", "2026-08-19"))
        // An unreadable date is worth seeing rather than blanking.
        assertEquals("sometime", visitDayLabel("sometime", "2026-08-19"))
    }

    // ── the wire shapes ───────────────────────────────────────────────────────

    @Test
    fun `a bound line carries its session id onto the request`() {
        val payload = InvoiceLineItem("Dog walk, 2026-08-11", 1.0, 2500L, sessionId = "s1")
            .toCreateInvoiceLine()
            .toPayload()
        assertEquals("s1", payload["sessionId"])
        assertEquals(2500L, payload["unitCents"])
        // "No discount" is the ABSENCE of one, not a discount of nothing.
        assertFalse(payload.containsKey("discountCents"))
    }

    @Test
    fun `an unbound line sends no session id at all`() {
        val payload = InvoiceLineItem("Mileage", 10.0, 70L).toCreateInvoiceLine().toPayload()
        assertFalse(payload.containsKey("sessionId"))
    }

    @Test
    fun `a discounted line sends the discount`() {
        val payload = InvoiceLineItem("Mileage", 1.0, 500L, discountCents = 100L).toCreateQuoteLine().toPayload()
        assertEquals(100L, payload["discountCents"])
    }
}
