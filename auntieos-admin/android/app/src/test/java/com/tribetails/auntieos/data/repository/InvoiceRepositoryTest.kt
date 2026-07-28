package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Payment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The [InvoiceRepository] wire contract, after ADR-0001 adoption.
 *
 * These payloads USED TO BE hand-mirrors of the server zod Args, and this file
 * used to pin their key sets because a key added or dropped there was contract
 * drift the compiler could not see. The generated request classes make that the
 * compiler's job. What is left to pin is the part the generator does not know:
 * how Android's own [Invoice] and [Payment] models map onto those classes, and
 * the client-side fallbacks the repo applies on top of a generated decode.
 *
 * The key-set assertions are KEPT rather than retired. They cost nothing, and a
 * schema change that drops a field the model still fills would otherwise pass
 * the build and go out on the wire missing.
 *
 * Kept pure so they run without Firebase static init, like
 * AssignAuntiePayloadTest / InvoiceContractsGeneratedTest.
 */
class InvoiceRepositoryTest {

    // ── recordPayment payload ────────────────────────────────────────────────

    private val payment = Payment(
        id = "pay1",                 // @DocumentId - must NOT ride the payload
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        client = "Rosa P.",
        address = "12 Elm St",
        date = "2026-05-01",
        paymentMethod = "Zelle",
        referenceNumber = "Z-123",
        email = "rosa@example.com",
        tip = 5.0,
        amount = 80.0,
        notes = "May walks",
        invoiceId = "inv1",
        invoiceNumber = "1042",
    )

    @Test
    fun `recordPayment carries every Payment field the zod Args declares`() {
        val p = recordPaymentArgs(payment).toPayload()
        // Exactly the 13 Args keys, nothing else (no id, no TestMode scoping).
        assertEquals(
            setOf(
                "kinfolkId", "kinfolkName", "client", "address", "date",
                "paymentMethod", "referenceNumber", "email", "amount", "tip",
                "notes", "invoiceId", "invoiceNumber",
            ),
            p.keys,
        )
        assertEquals("kf1", p["kinfolkId"])
        assertEquals("Rosa Parks", p["kinfolkName"])
        assertEquals("Rosa P.", p["client"])
        assertEquals("12 Elm St", p["address"])
        assertEquals("2026-05-01", p["date"])
        assertEquals("Zelle", p["paymentMethod"])
        assertEquals("Z-123", p["referenceNumber"])
        assertEquals("rosa@example.com", p["email"])
        assertEquals(80.0, p["amount"])
        assertEquals(5.0, p["tip"])
        assertEquals("May walks", p["notes"])
        assertEquals("inv1", p["invoiceId"])
        assertEquals("1042", p["invoiceNumber"])
    }

    @Test
    fun `recordPayment payload never carries the client-side doc id`() {
        assertFalse(recordPaymentArgs(payment).toPayload().containsKey("id"))
    }

    @Test
    fun `recordPayment payload passes the caller's kinfolkId through untouched`() {
        // The old direct write rewrote kinfolkId client-side via
        // TestMode.scopedKinfolkId. The payload must NOT: the sandbox stamp is
        // the server's job now (lib/testMode.ts), so what the caller set is
        // exactly what is sent.
        val standalone = payment.copy(kinfolkId = "", invoiceId = "", invoiceNumber = "")
        val p = recordPaymentArgs(standalone).toPayload()
        assertEquals("", p["kinfolkId"])
        assertEquals("", p["invoiceId"])
    }

    // ── createInvoice / createQuote payloads ─────────────────────────────────
    // Named by ADR-0001 as the mirror "inspected by no test". It is inspected
    // now, and by a test that could not have been written against the old
    // inline map: these are pure functions taking an already-scoped familyId.

    private val invoice = Invoice(
        id = "inv1",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        invoiceNumber = "1042",
        client = "Rosa P.",
        address = "12 Elm St",
        date = "2026-05-01",
        terms = "Net 30",
        dueDate = "2026-05-31",
        discount = "10",
        total = 40.0,
        amountDue = 40.0,
        status = "draft",
        sessionIds = listOf("ses1", "ses2"),
    )

    @Test
    fun `createInvoice sends the sandbox-scoped familyId, not the invoice's own kinfolkId`() {
        val p = createInvoiceArgs(invoice, familyId = "test-tribe").toPayload()
        assertEquals("test-tribe", p["familyId"])
        assertFalse("kinfolkId is not an arg of this callable", p.containsKey("kinfolkId"))
    }

    @Test
    fun `createInvoice carries the composer's fields including its status`() {
        val p = createInvoiceArgs(invoice, familyId = "kf1").toPayload()
        assertEquals(
            setOf(
                "familyId", "kinfolkName", "invoiceNumber", "client", "address",
                "date", "terms", "dueDate", "discount", "total", "amountDue",
                "status", "sessionIds",
            ),
            p.keys,
        )
        assertEquals("draft", p["status"])
        assertEquals(40.0, p["total"])
        assertEquals(listOf("ses1", "ses2"), p["sessionIds"])
        // The line-item pair is the alternative to total/amountDue, not an
        // addition to it, so an absent one must stay absent rather than ship
        // empty and read as "this invoice has no lines".
        assertFalse(p.containsKey("lineItems"))
        assertFalse(p.containsKey("invoiceDiscountCents"))
    }

    @Test
    fun `createQuote leaves status at the schema default rather than forwarding the composer's`() {
        // createQuote mints in QUOTE status regardless of the arg and never
        // reads it (admin/createQuote.ts), so forwarding "draft" here would put
        // a request on the wire that the server refuses to honour.
        val p = createQuoteArgs(invoice, familyId = "kf1", sendToKinfolk = true).toPayload()
        assertEquals("", p["status"])
        assertEquals(true, p["sendToKinfolk"])
        assertEquals("1042", p["invoiceNumber"])
    }

    // ── markInvoicePaid payload ──────────────────────────────────────────────

    @Test
    fun `markInvoicePaid omits a blank method and reference rather than sending empty strings`() {
        // The server types both `z.string().trim().min(1).optional()`, so a
        // blank one is not a weaker version of an absent one: it fails
        // validation and the whole payment is refused.
        val p = markInvoicePaidArgs("inv1", amount = 20.0, method = "", reference = "   ").toPayload()
        assertEquals(setOf("invoiceId", "amount"), p.keys)
    }

    @Test
    fun `markInvoicePaid sends what the operator did fill in`() {
        val p = markInvoicePaidArgs("inv1", amount = 20.0, method = "Zelle", reference = "Z-123").toPayload()
        assertEquals(setOf("invoiceId", "amount", "method", "reference"), p.keys)
        assertEquals("Zelle", p["method"])
        assertEquals("Z-123", p["reference"])
    }

    @Test
    fun `markInvoicePaid omits a null amount, which is the settle-the-rest case`() {
        val p = markInvoicePaidArgs("inv1", amount = null, method = "Cash", reference = "").toPayload()
        assertEquals(setOf("invoiceId", "method"), p.keys)
    }

    // ── archiveInvoice payload ───────────────────────────────────────────────

    @Test
    fun `archiveInvoice omits force unless the operator chose the write-off`() {
        assertEquals(setOf("invoiceId"), archiveInvoiceArgs("inv1", force = false).toPayload().keys)
        val forced = archiveInvoiceArgs("inv1", force = true).toPayload()
        assertEquals(setOf("invoiceId", "force"), forced.keys)
        assertEquals(true, forced["force"])
    }

    // ── linkInvoiceSessions result decode ────────────────────────────────────

    @Test
    fun `invoiceSessionLinks reads the full server payload`() {
        val decoded = invoiceSessionLinksOf(
            mapOf(
                "ok" to true,
                "invoiceId" to "inv1",
                "sessionIds" to listOf("ses2", "ses3"),
                "added" to listOf("ses3"),
                "removed" to listOf("ses1"),
                "status" to "sent",
                "editScope" to "all",
            ),
            requestedInvoiceId = "inv1",
            requestedSessionIds = listOf("ses2", "ses3"),
        )
        assertEquals("inv1", decoded.invoiceId)
        assertEquals(listOf("ses2", "ses3"), decoded.sessionIds)
        assertEquals(listOf("ses3"), decoded.added)
        assertEquals(listOf("ses1"), decoded.removed)
        assertEquals("sent", decoded.status)
        assertEquals("all", decoded.editScope)
    }

    @Test
    fun `invoiceSessionLinks falls back to the requested set on a null payload`() {
        // The call succeeded (we only decode after a successful await), so the
        // requested set IS the stored set; duplicates collapse like the server's.
        val decoded = invoiceSessionLinksOf(
            null,
            requestedInvoiceId = "inv1",
            requestedSessionIds = listOf("ses1", "ses1", "ses2"),
        )
        assertEquals("inv1", decoded.invoiceId)
        assertEquals(listOf("ses1", "ses2"), decoded.sessionIds)
        assertTrue(decoded.added.isEmpty())
        assertTrue(decoded.removed.isEmpty())
        assertEquals("", decoded.status)
        assertEquals("", decoded.editScope)
    }

    @Test
    fun `invoiceSessionLinks drops non-string entries and tolerates partial payloads`() {
        val decoded = invoiceSessionLinksOf(
            mapOf(
                "invoiceId" to "",                       // blank → requested id
                "sessionIds" to listOf("ses1", 7, null), // junk entries dropped
                "added" to "not-a-list",                 // wrong type → empty
            ),
            requestedInvoiceId = "inv9",
            requestedSessionIds = listOf("ses1"),
        )
        assertEquals("inv9", decoded.invoiceId)
        assertEquals(listOf("ses1"), decoded.sessionIds)
        assertTrue(decoded.added.isEmpty())
        assertTrue(decoded.removed.isEmpty())
    }

    @Test
    fun `invoiceSessionLinks reads an empty stored set as empty, not as the requested fallback`() {
        // `[]` unlinks everything; an explicit empty list from the server must
        // decode as empty rather than falling back to what was requested. The
        // generated decoder alone cannot tell those apart - both are an empty
        // list by the time it is done - which is why the fallback is decided
        // off the raw payload.
        val decoded = invoiceSessionLinksOf(
            mapOf("invoiceId" to "inv1", "sessionIds" to emptyList<String>(), "removed" to listOf("ses1")),
            requestedInvoiceId = "inv1",
            requestedSessionIds = emptyList(),
        )
        assertTrue(decoded.sessionIds.isEmpty())
        assertEquals(listOf("ses1"), decoded.removed)
    }

    @Test
    fun `invoiceSessionLinks unlinking everything is not read as a failed decode`() {
        // The save that clears every link sends [] and gets [] back. Falling
        // back here would tell the screen the links survived the unlink.
        val decoded = invoiceSessionLinksOf(
            mapOf("invoiceId" to "inv1", "sessionIds" to emptyList<String>(), "removed" to listOf("ses1", "ses2")),
            requestedInvoiceId = "inv1",
            requestedSessionIds = listOf("ses1", "ses2"),
        )
        assertTrue(decoded.sessionIds.isEmpty())
    }

    // ── sendInvoiceReminder result decode ────────────────────────────────────
    @Test
    fun `reminder decode echoes server invoiceId`() {
        assertEquals("inv-9", reminderInvoiceIdOrRequested(mapOf("ok" to true, "invoiceId" to "inv-9"), "inv-1"))
    }
    @Test
    fun `reminder decode falls back to requested id when missing`() {
        assertEquals("inv-1", reminderInvoiceIdOrRequested(mapOf("ok" to true), "inv-1"))
        assertEquals("inv-1", reminderInvoiceIdOrRequested(null, "inv-1"))
    }
    @Test
    fun `reminder decode falls back when server id is blank`() {
        assertEquals("inv-1", reminderInvoiceIdOrRequested(mapOf("invoiceId" to ""), "inv-1"))
    }

    // ── construction ─────────────────────────────────────────────────────────
    @Test
    fun `constructing the repo touches no Firebase singleton`() {
        // The Firebase handles are lazy PROVIDERS, not eager constructor
        // arguments, so `AuntieOSApp.instance.invoiceRepository` is safe to name
        // as a ViewModel default argument in a Firebase-less Robolectric test.
        // Turning any of them back into an eager `FirebaseFirestore.getInstance()`
        // default would blow up here with "Default FirebaseApp is not
        // initialized" rather than in a screenshot golden three files away.
        //
        // W4-2 took the whole argument list away: the TestMode lambda became the
        // default `AuthGate.shared`, which holds its own FirebaseAuth lazily, so
        // the zero-argument construction below has to stay Firebase-free too
        // (AuthGateTest pins that half).
        val repo = InvoiceRepository()
        assertNotNull(repo)
    }
}
