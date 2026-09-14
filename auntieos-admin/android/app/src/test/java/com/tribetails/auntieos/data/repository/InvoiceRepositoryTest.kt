package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.data.contracts.CreateInvoiceArgsLineItem
import com.tribetails.auntieos.data.contracts.CreateQuoteArgsLineItem
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
 * KinCareRepositoryTest / InvoiceContractsGeneratedTest.
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
                // Added 2026-08-04. `fee` is the field whose absence made
                // invoice #1029 unreconcilable; the two booleans are the
                // Auto-apply and Send Confirmation Email switches.
                "fee", "notes", "invoiceId", "invoiceNumber",
                "autoApply", "sendConfirmationEmail",
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
    fun `recordPayment payload names the settlement only when one preceded it (#866)`() {
        // The server tells the office "paid" for a markInvoicePaid settlement only
        // when this id matches it, so it is sent exactly as given, and a payment no
        // settlement step preceded sends nothing at all rather than an empty id.
        val withSettlement = recordPaymentArgs(payment, "pay_1_abc", "ipay-9").toPayload()
        assertEquals("ipay-9", withSettlement["settledByInvoicePaymentId"])
        assertFalse(recordPaymentArgs(payment).toPayload().containsKey("settledByInvoicePaymentId"))
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
    fun `createInvoice omits a blank invoice number rather than sending an empty one`() {
        // #408: the server mints the next number from a transactional counter
        // when the key is absent, which is what the composer relies on now that
        // nobody types one. An empty string would happen to mint too, but it
        // puts an answer on the wire to a question the client did not ask.
        val p = createInvoiceArgs(invoice.copy(invoiceNumber = "   "), familyId = "kf1").toPayload()
        assertFalse(p.containsKey("invoiceNumber"))
    }

    @Test
    fun `createInvoice carries the structured terms code and the bound lines`() {
        val p = createInvoiceArgs(
            invoice,
            familyId = "kf1",
            termsCode = "net_14_after_last_visit",
            lineItems = listOf(
                CreateInvoiceArgsLineItem(
                    description = "Dog walk, 2026-08-11",
                    qty = 1.0,
                    unitCents = 2500L,
                    sessionId = "ses1",
                ),
            ),
            invoiceDiscountCents = 500L,
        ).toPayload()

        assertEquals("net_14_after_last_visit", p["termsCode"])
        assertEquals(500L, p["invoiceDiscountCents"])
        @Suppress("UNCHECKED_CAST")
        val lines = p["lineItems"] as List<Map<String, Any?>>
        assertEquals(1, lines.size)
        // The session id is what makes it a BOUND line: without it the invoice
        // cannot be routed back to the work it bills for.
        assertEquals("ses1", lines.single()["sessionId"])
        assertEquals(2500L, lines.single()["unitCents"])
    }

    @Test
    fun `the blank path leaves lineItems off the payload entirely`() {
        // NOT an empty list. The server reads the KEY'S PRESENCE as "this
        // invoice is itemized", so an empty one arms updateInvoice's recompute
        // on an invoice whose total was typed by hand, and a later due-date
        // correction would rewrite that total to $0.
        val p = createInvoiceArgs(invoice, familyId = "kf1", termsCode = "due_on_receipt").toPayload()
        assertFalse(p.containsKey("lineItems"))
        assertFalse(p.containsKey("invoiceDiscountCents"))
        assertEquals("due_on_receipt", p["termsCode"])
    }

    @Test
    fun `a caller that sends no terms code leaves terms and dueDate stored verbatim`() {
        // The pre-#408 shape, still reachable: an absent termsCode means the
        // server stores what it was given rather than owning the due date.
        val p = createInvoiceArgs(invoice, familyId = "kf1").toPayload()
        assertFalse(p.containsKey("termsCode"))
        assertEquals("Net 30", p["terms"])
        assertEquals("2026-05-31", p["dueDate"])
    }

    @Test
    fun `createQuote carries the terms code and bound lines too`() {
        val p = createQuoteArgs(
            invoice,
            familyId = "kf1",
            sendToKinfolk = false,
            termsCode = "net_7",
            lineItems = listOf(
                CreateQuoteArgsLineItem(description = "Dog walk", qty = 1.0, unitCents = 2500L, sessionId = "ses1"),
            ),
        ).toPayload()
        assertEquals("net_7", p["termsCode"])
        @Suppress("UNCHECKED_CAST")
        val lines = p["lineItems"] as List<Map<String, Any?>>
        assertEquals("ses1", lines.single()["sessionId"])
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

    // ── the #825 idempotency keys on the wire ────────────────────────────────

    /**
     * ABSENT IS THE DEFAULT, AND IT HAS TO STAY THAT WAY. The server types every
     * one of these `.optional()`, never `.nullable().optional()`, because
     * Kotlin's one `T?` cannot distinguish "key omitted" from "key sent null" —
     * so an absent key means exactly one thing: mint me an id, no dedupe. Every
     * caller that has not adopted a key must keep behaving as it always did, and
     * a null that reached the wire as an explicit null would fail validation and
     * refuse the write outright.
     */
    @Test
    fun `every money payload omits the idempotency key when the caller has none`() {
        assertFalse(createInvoiceArgs(invoice, familyId = "kf1").toPayload().containsKey("idempotencyKey"))
        assertFalse(
            createQuoteArgs(invoice, familyId = "kf1", sendToKinfolk = false)
                .toPayload().containsKey("idempotencyKey"),
        )
        assertFalse(
            markInvoicePaidArgs("inv1", amount = 20.0, method = "Cash", reference = "")
                .toPayload().containsKey("idempotencyKey"),
        )
        assertFalse(recordPaymentArgs(payment).toPayload().containsKey("idempotencyKey"))
    }

    /**
     * And when the caller HAS one it reaches the wire verbatim, under the key
     * name the four zod schemas share. Each value carries the prefix its own
     * callable guards, because two of these land in the same `invoices`
     * collection and the prefix is the only thing separating them.
     */
    @Test
    fun `a minted key reaches the wire untouched, under each callable's own prefix`() {
        assertEquals(
            "inv_1789000000000_abc123",
            createInvoiceArgs(invoice, familyId = "kf1", idempotencyKey = "inv_1789000000000_abc123")
                .toPayload()["idempotencyKey"],
        )
        assertEquals(
            "quot_1789000000000_abc123",
            createQuoteArgs(
                invoice,
                familyId = "kf1",
                sendToKinfolk = true,
                idempotencyKey = "quot_1789000000000_abc123",
            ).toPayload()["idempotencyKey"],
        )
        assertEquals(
            "ipay_1789000000000_abc123",
            markInvoicePaidArgs(
                "inv1",
                amount = 20.0,
                method = "Cash",
                reference = "",
                idempotencyKey = "ipay_1789000000000_abc123",
            ).toPayload()["idempotencyKey"],
        )
        assertEquals(
            "pay_1789000000000_abc123",
            recordPaymentArgs(payment, idempotencyKey = "pay_1789000000000_abc123")
                .toPayload()["idempotencyKey"],
        )
    }

    // ── archiveInvoice payload ───────────────────────────────────────────────

    @Test
    fun `archiveInvoice omits force unless the operator chose the write-off`() {
        assertEquals(setOf("invoiceId"), archiveInvoiceArgs("inv1", force = false).toPayload().keys)
        val forced = archiveInvoiceArgs("inv1", force = true).toPayload()
        assertEquals(setOf("invoiceId", "force"), forced.keys)
        assertEquals(true, forced["force"])
    }

    // ── resendQuote payload (issue #448) ─────────────────────────────────────
    @Test
    fun `resendQuote carries the invoice id and nothing else`() {
        // The server needs no more than that: it reads the household, the
        // decision and the due date off the doc, so a client cannot assert any
        // of the three. TestMode scoping is server-side, same as the other
        // ADR-0002 callables.
        val payload = com.tribetails.auntieos.data.contracts.ResendQuoteArgs(invoiceId = "inv1").toPayload()
        assertEquals(setOf("invoiceId"), payload.keys)
        assertEquals("inv1", payload["invoiceId"])
    }
    @Test
    fun `resendQuote decodes the state the resend left behind`() {
        val decoded = com.tribetails.auntieos.data.contracts.decodeResendQuoteResult(
            mapOf("ok" to true, "invoiceId" to "inv1", "status" to "quote"),
        )
        assertTrue(decoded.ok)
        assertEquals("quote", decoded.status)
        // Fail-soft, like every other generated decoder: a missing status is an
        // empty string, never a thrown decode over a call that succeeded.
        assertEquals("", com.tribetails.auntieos.data.contracts.decodeResendQuoteResult(null).status)
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
