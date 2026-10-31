package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.data.contracts.UpdateInvoiceArgs
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.domain.InvoiceEditScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1174: the Android invoice editor's gating and payload, pinned against the
 * web editor's `saveEdit` and the `updateInvoice` input schema.
 *
 * THE PAYLOAD ASSERTIONS ARE ON THE WIRE MAP, not on the Kotlin patch, because
 * the map is what the server's `.strict()` zod schema reads: a key that is
 * present at all is a write, so "this field was not sent" has to be checked as
 * key absence.
 */
class InvoiceEditFormTest {

    private fun itemized(scope: String = "all") = Invoice(
        id = "inv1",
        kinfolkId = "fam1",
        kinfolkName = "Wanda Thorne",
        invoiceNumber = "1042",
        client = "Wanda Thorne",
        address = "12 Elm Row",
        date = "2026-10-01",
        dueDate = "2026-10-15",
        terms = "Net 14",
        discount = "10%",
        total = 60.0,
        amountDue = 60.0,
        status = "open",
        editScope = scope,
        lineItems = listOf(
            mapOf("description" to "Dog walk", "qty" to 2, "unitCents" to 2500, "sessionId" to "s1"),
            mapOf("description" to "Mileage", "qty" to 1, "unitCents" to 1000),
        ),
        invoiceDiscountCents = 0L,
    )

    /** Every invoice before Task 5.1: a typed total and no `lineItems` key at all. */
    private fun unitemized(scope: String = "all") = Invoice(
        id = "inv2",
        invoiceNumber = "1043",
        date = "2026-10-01",
        dueDate = "2026-10-15",
        total = 40.0,
        amountDue = 40.0,
        status = "open",
        editScope = scope,
    )

    private fun wire(invoice: Invoice, draft: InvoiceEditDraft): Map<String, Any?> {
        val outcome = invoiceEditPatchOf(invoice, draft)
        assertNull("unexpected refusal: ${outcome.error}", outcome.error)
        return UpdateInvoiceArgs(invoice.id, outcome.patch!!).toPayload()["patch"] as Map<String, Any?>
    }

    // ── Gating, from the STORED editScope ──────────────────────────────────────

    @Test
    fun `scope none opens no editor`() {
        assertNull(invoiceEditDraftOf(itemized(scope = "none")))
    }

    @Test
    fun `an absent or unknown scope opens no editor`() {
        assertNull(invoiceEditDraftOf(itemized().apply { editScope = null }))
        assertNull(invoiceEditDraftOf(itemized(scope = "everything")))
    }

    @Test
    fun `scope all opens the money for editing`() {
        val draft = invoiceEditDraftOf(itemized(scope = "all"))!!
        assertEquals(InvoiceEditScope.ALL, draft.scope)
        assertTrue(draft.moneyEditable)
    }

    @Test
    fun `scope metadataOnly opens the form with the money read-only but present`() {
        val draft = invoiceEditDraftOf(itemized(scope = "metadataOnly"))!!
        assertEquals(InvoiceEditScope.METADATA_ONLY, draft.scope)
        assertFalse(draft.moneyEditable)
        // Shown, not hidden: the lines are on the draft for the read-only view.
        assertEquals(listOf("Dog walk", "Mileage"), draft.lines.map { it.description })
    }

    @Test
    fun `the draft opens on the stored values and keeps each line's binding`() {
        val draft = invoiceEditDraftOf(itemized())!!
        assertEquals("1042", draft.invoiceNumber)
        assertEquals("2026-10-01", draft.date)
        assertEquals("2026-10-15", draft.dueDate)
        assertEquals("Net 14", draft.terms)
        assertTrue(draft.wasItemized)
        assertEquals(InvoiceEditLine("Dog walk", "2", "25.00", "", "s1"), draft.lines[0])
        assertEquals(InvoiceEditLine("Mileage", "1", "10.00", "", ""), draft.lines[1])
    }

    // ── The payload ────────────────────────────────────────────────────────────

    @Test
    fun `an unchanged form sends nothing and says so`() {
        val locked = itemized(scope = "metadataOnly")
        val none = invoiceEditPatchOf(locked, invoiceEditDraftOf(locked)!!)
        assertNull(none.patch)
        assertEquals("Nothing has changed yet.", none.error)

        val unitemized = unitemized()
        val alsoNone = invoiceEditPatchOf(unitemized, invoiceEditDraftOf(unitemized)!!)
        assertNull(alsoNone.patch)
        assertEquals("Nothing has changed yet.", alsoNone.error)
    }

    @Test
    fun `under all an itemized invoice re-sends its lines, as web does`() {
        // Web's `touchedMoney = wasItemized || lines.length > 0`: an itemized
        // invoice's lines go with every save, which recomputes from the same
        // lines and so leaves the figures where they were.
        val invoice = itemized()
        val outcome = invoiceEditPatchOf(invoice, invoiceEditDraftOf(invoice)!!)
        assertNotNull(outcome.patch)
        assertEquals(2, outcome.patch!!.lineItems!!.size)
    }

    @Test
    fun `only changed metadata is sent, and no field the form does not control`() {
        val invoice = itemized(scope = "metadataOnly")
        val draft = invoiceEditDraftOf(invoice)!!.copy(dueDate = "2026-10-30")
        val patch = wire(invoice, draft)
        assertEquals(mapOf("dueDate" to "2026-10-30"), patch)
    }

    @Test
    fun `metadataOnly never sends money, even when the rows were changed underneath it`() {
        val invoice = itemized(scope = "metadataOnly")
        val base = invoiceEditDraftOf(invoice)!!
        val draft = base.copy(
            terms = "Net 30",
            lines = base.lines.replacedAt(1, base.lines[1].copy(unitText = "99.00")),
            invoiceDiscountText = "5.00",
        )
        val patch = wire(invoice, draft)
        assertEquals(mapOf("terms" to "Net 30"), patch)
    }

    @Test
    fun `a due-date fix on an un-itemized invoice sends no lineItems key`() {
        // THE UN-ITEMIZED GUARD. `lineItems: []` would itemize the invoice as
        // billing nothing and the server would rewrite its $40 to $0.
        val invoice = unitemized()
        val draft = invoiceEditDraftOf(invoice)!!.copy(dueDate = "2026-11-01")
        val patch = wire(invoice, draft)
        assertEquals(mapOf("dueDate" to "2026-11-01"), patch)
        assertFalse(patch.containsKey("lineItems"))
        assertFalse(patch.containsKey("invoiceDiscountCents"))
    }

    @Test
    fun `adding the first line to an un-itemized invoice sends lines and discount together`() {
        val invoice = unitemized()
        val draft = invoiceEditDraftOf(invoice)!!.copy(
            lines = listOf(InvoiceEditLine(description = "Overnight stay", qtyText = "1", unitText = "40")),
        )
        val patch = wire(invoice, draft)
        assertEquals(
            listOf(mapOf("description" to "Overnight stay", "qty" to 1.0, "unitCents" to 4000L)),
            patch["lineItems"],
        )
        assertEquals(0L, patch["invoiceDiscountCents"])
        assertEquals(setOf("lineItems", "invoiceDiscountCents"), patch.keys)
    }

    @Test
    fun `a money edit replaces the lines wholesale and keeps the visit binding`() {
        val invoice = itemized()
        val base = invoiceEditDraftOf(invoice)!!
        val draft = base.copy(
            lines = base.lines.replacedAt(1, base.lines[1].copy(qtyText = "3", discountText = "2.50")),
            invoiceDiscountText = "5",
        )
        val patch = wire(invoice, draft)
        assertEquals(
            listOf(
                mapOf("description" to "Dog walk", "qty" to 2.0, "unitCents" to 2500L, "sessionId" to "s1"),
                mapOf("description" to "Mileage", "qty" to 3.0, "unitCents" to 1000L, "discountCents" to 250L),
            ),
            patch["lineItems"],
        )
        assertEquals(500L, patch["invoiceDiscountCents"])
        // No metadata changed, so none is echoed.
        assertEquals(setOf("lineItems", "invoiceDiscountCents"), patch.keys)
    }

    @Test
    fun `removing every line of an itemized invoice sends an empty list`() {
        val invoice = itemized()
        val draft = invoiceEditDraftOf(invoice)!!.copy(lines = emptyList())
        val patch = wire(invoice, draft)
        assertEquals(emptyList<Any>(), patch["lineItems"])
    }

    @Test
    fun `metadata is trimmed and terms are sent as typed`() {
        val invoice = itemized(scope = "metadataOnly")
        val draft = invoiceEditDraftOf(invoice)!!.copy(invoiceNumber = " 1050 ", date = "2026-10-02 ", terms = "Net 30 ")
        val patch = wire(invoice, draft)
        assertEquals(mapOf("invoiceNumber" to "1050", "date" to "2026-10-02", "terms" to "Net 30 "), patch)
    }

    // ── Refusals before the round trip ─────────────────────────────────────────

    @Test
    fun `a blank invoice number is refused`() {
        val invoice = itemized(scope = "metadataOnly")
        val outcome = invoiceEditPatchOf(invoice, invoiceEditDraftOf(invoice)!!.copy(invoiceNumber = "  "))
        assertNull(outcome.patch)
        assertEquals("The invoice number cannot be empty.", outcome.error)
    }

    @Test
    fun `a date that is not YYYY-MM-DD is refused`() {
        val invoice = itemized(scope = "metadataOnly")
        val outcome = invoiceEditPatchOf(invoice, invoiceEditDraftOf(invoice)!!.copy(dueDate = "next Friday"))
        assertNull(outcome.patch)
        assertEquals("The due date needs to be a date like 2026-10-23.", outcome.error)
    }

    @Test
    fun `an unreadable price names its row and sends nothing`() {
        val invoice = itemized()
        val base = invoiceEditDraftOf(invoice)!!
        val draft = base.copy(lines = base.lines.replacedAt(1, base.lines[1].copy(unitText = "ten")))
        val outcome = invoiceEditPatchOf(invoice, draft)
        assertNull(outcome.patch)
        assertEquals("Unit price for \"Mileage\" needs a dollar amount, for example 25.00.", outcome.error)
    }

    @Test
    fun `a discount larger than the subtotal is refused with both figures`() {
        val invoice = itemized()
        val draft = invoiceEditDraftOf(invoice)!!.copy(invoiceDiscountText = "100")
        val outcome = invoiceEditPatchOf(invoice, draft)
        assertNull(outcome.patch)
        assertEquals("Invoice discount ($100.00) is larger than the subtotal ($60.00).", outcome.error)
    }

    // ── #1198: household, client, address and the legacy discount text ────────
    @Test
    fun `the draft opens with the stored household, client, address and discount text`() {
        val draft = invoiceEditDraftOf(itemized())!!
        assertEquals("Wanda Thorne", draft.kinfolkName)
        assertEquals("Wanda Thorne", draft.client)
        assertEquals("12 Elm Row", draft.address)
        assertEquals("10%", draft.discount)
    }
    @Test
    fun `an untouched draft sends none of the four, so a metadata save cannot blank them`() {
        val invoice = itemized()
        val draft = invoiceEditDraftOf(invoice)!!.copy(terms = "Net 30")
        val patch = wire(invoice, draft)
        for (key in listOf("kinfolkName", "client", "address", "discount")) {
            assertFalse("$key was sent unchanged", patch.containsKey(key))
        }
    }
    @Test
    fun `only the changed one of the four is sent`() {
        val invoice = itemized()
        val draft = invoiceEditDraftOf(invoice)!!.copy(address = "14 Elm Row")
        val patch = wire(invoice, draft)
        assertEquals("14 Elm Row", patch["address"])
        assertFalse(patch.containsKey("client"))
        assertFalse(patch.containsKey("kinfolkName"))
        assertFalse(patch.containsKey("discount"))
    }
    @Test
    fun `all four are sent as typed when all four change`() {
        val invoice = unitemized()
        val draft = invoiceEditDraftOf(invoice)!!.copy(
            kinfolkName = "The Riveras",
            client = "Ana Rivera",
            address = "12 Elm St",
            discount = "10% loyalty",
        )
        assertEquals(
            mapOf(
                "kinfolkName" to "The Riveras",
                "client" to "Ana Rivera",
                "address" to "12 Elm St",
                "discount" to "10% loyalty",
            ),
            wire(invoice, draft),
        )
    }
    @Test
    fun `clearing a wrong address sends it as an empty string`() {
        val invoice = itemized(scope = "metadataOnly")
        val draft = invoiceEditDraftOf(invoice)!!.copy(address = "")
        assertEquals(mapOf("address" to ""), wire(invoice, draft))
    }
    @Test
    fun `the four stay editable when the money is locked, and no money key rides along`() {
        val invoice = itemized(scope = "metadataOnly")
        val draft = invoiceEditDraftOf(invoice)!!.copy(client = "Ana Rivera", discount = "waived")
        assertEquals(mapOf("client" to "Ana Rivera", "discount" to "waived"), wire(invoice, draft))
    }
    @Test
    fun `an address longer than the server allows is refused before the round trip`() {
        val invoice = itemized()
        val draft = invoiceEditDraftOf(invoice)!!.copy(address = "x".repeat(501))
        val outcome = invoiceEditPatchOf(invoice, draft)
        assertNull(outcome.patch)
        assertEquals("Address cannot be more than 500 characters.", outcome.error)
    }
    // ── Editor helpers ─────────────────────────────────────────────────────────

    @Test
    fun `the preview counts unreadable rows instead of treating them as zero`() {
        val preview = invoiceEditPreviewOf(
            listOf(InvoiceEditLine("A", "2", "10"), InvoiceEditLine("B", "1", "")),
            "5",
        )
        assertEquals(1500L, preview.totalCents)
        assertEquals(1, preview.unreadable)
    }

    @Test
    fun `moving a line stays inside the list`() {
        val rows = listOf(InvoiceEditLine("A"), InvoiceEditLine("B"))
        assertEquals(listOf("B", "A"), rows.movedBy(0, 1).map { it.description })
        assertEquals(listOf("A", "B"), rows.movedBy(0, -1).map { it.description })
    }
}
