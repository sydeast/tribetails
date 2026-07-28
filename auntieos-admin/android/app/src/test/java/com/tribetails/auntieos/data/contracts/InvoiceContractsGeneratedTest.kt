package com.tribetails.auntieos.data.contracts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The generated Contracts module, exercised where Kotlin actually runs
 * (ADR-0001 decision 2).
 *
 * The generator's own tests (mytribe/functions/test/contractsCodegen.test.ts)
 * pin the emitted SOURCE. This file pins its BEHAVIOUR, because the emitted
 * source is only interesting if a junk payload decodes the way
 * `decodeInvoiceSettlement` and `decodeInvoiceSessionLinks` decode one today.
 * A callable response arrives after the server write has already committed, so
 * a decoder that threw would report collected money as a failed collection,
 * and every screen in this app renders a failure as a retry affordance.
 *
 * NOTHING HERE IS RE-POINTED YET. `InvoiceRepository` still uses its
 * hand-mirrors; adoption is a later, per-client change. These tests are what
 * make that swap reviewable rather than hopeful.
 */
class InvoiceContractsGeneratedTest {

    // ── Decoders: the fail-soft contract ─────────────────────────────────────

    @Test
    fun `a null payload decodes to neutral values rather than throwing`() {
        val settled = decodeMarkInvoicePaidResult(null)
        assertEquals("", settled.state)
        assertEquals(0L, settled.totalCents)
        assertEquals(0L, settled.paidCents)
        assertEquals(0L, settled.amountDueCents)
        assertEquals(0L, settled.overpaidCents)
        assertEquals("", settled.invoiceId)
        assertEquals(false, settled.ok)
    }

    @Test
    fun `an empty payload decodes to the same neutral values as a null one`() {
        assertEquals(decodeMarkInvoicePaidResult(null), decodeMarkInvoicePaidResult(emptyMap()))
    }

    @Test
    fun `a payload of entirely wrong types still decodes`() {
        val junk = mapOf<String, Any?>(
            "ok" to "yes",
            "invoiceId" to 42,
            "paymentId" to listOf("nope"),
            "state" to 7,
            "totalCents" to "4000",
            "paidCents" to null,
            "amountDueCents" to mapOf("a" to 1),
            "overpaidCents" to true,
        )
        val settled = decodeMarkInvoicePaidResult(junk)
        assertEquals("", settled.invoiceId)
        assertEquals("", settled.paymentId)
        assertEquals("", settled.state)
        assertEquals(0L, settled.totalCents)
        assertEquals(false, settled.ok)
    }

    @Test
    fun `a real markInvoicePaid response decodes field for field`() {
        val settled = decodeMarkInvoicePaidResult(
            mapOf(
                "ok" to true,
                "invoiceId" to "inv1",
                "paymentId" to "pay9",
                "state" to "partial",
                "totalCents" to 4000,
                "paidCents" to 2000,
                "amountDueCents" to 2000,
                "overpaidCents" to 0,
            ),
        )
        assertEquals("inv1", settled.invoiceId)
        assertEquals("pay9", settled.paymentId)
        assertEquals("partial", settled.state)
        assertEquals(4000L, settled.totalCents)
        assertEquals(2000L, settled.amountDueCents)
        assertTrue(settled.ok)
    }

    @Test
    fun `cents survive whichever Number the callable transport hands back`() {
        // The Firebase SDK deserialises JSON numbers as Integer, Long or
        // Double depending on magnitude and decimal point. Every one of those
        // is the same money.
        for (wire in listOf<Any>(4000, 4000L, 4000.0)) {
            val settled = decodeMarkInvoicePaidResult(mapOf("totalCents" to wire))
            assertEquals("wire value $wire", 4000L, settled.totalCents)
        }
    }

    @Test
    fun `an enum arrives verbatim and an unknown member is not rewritten`() {
        // The vocabulary lives in the KDoc, not in the type: a ninth invoice
        // state added server-side reaches the client as itself rather than
        // being coerced into one of the eight this build happens to know.
        val links = decodeLinkInvoiceSessionsResult(mapOf("status" to "escrowed"))
        assertEquals("escrowed", links.status)
    }

    @Test
    fun `list entries of the wrong type are dropped, not defaulted into place`() {
        val links = decodeLinkInvoiceSessionsResult(
            mapOf(
                "sessionIds" to listOf("s1", 2, null, "s3"),
                "added" to "not a list",
                "removed" to emptyList<String>(),
            ),
        )
        assertEquals(listOf("s1", "s3"), links.sessionIds)
        assertEquals(emptyList<String>(), links.added)
        assertEquals(emptyList<String>(), links.removed)
    }

    @Test
    fun `a list of objects decodes through the nested decoder and skips non-maps`() {
        val result = decodeGetMyInvoicesResult(
            mapOf(
                "open" to listOf(
                    mapOf("id" to "inv1", "status" to "open", "total" to 40.0),
                    "not an invoice",
                    mapOf("id" to "inv2", "status" to "draft", "amountDue" to 12.5),
                ),
                "paid" to emptyList<Any>(),
                "credits" to null,
                "accountBalanceCents" to 250,
            ),
        )
        assertEquals(2, result.open.size)
        assertEquals("inv1", result.open[0].id)
        assertEquals(40.0, result.open[0].total, 0.0)
        assertEquals("draft", result.open[1].status)
        assertEquals(12.5, result.open[1].amountDue, 0.0)
        assertEquals(emptyList<InvoiceDto>(), result.credits)
        assertEquals(250.0, result.accountBalanceCents, 0.0)
    }

    @Test
    fun `an absent optional list decodes to null, an absent nullable scalar to null`() {
        val invoice = decodeInvoiceDto(mapOf("id" to "inv1"))
        // `lineItems` is `.optional()` server-side: absent when the invoice has
        // no lines at all, which is not the same claim as "it has none".
        assertNull(invoice.lineItems)
        assertNull(invoice.editScope)
        assertNull(invoice.creditAmountCents)
        assertEquals("", invoice.status)
    }

    @Test
    fun `a record drops entries whose key or value is the wrong type`() {
        val report = decodeRepairInvoicePaymentsResult(
            mapOf(
                "mode" to "detect",
                "skipped" to mapOf(
                    "no_total" to 3,
                    "no_payments" to "many",
                    7 to 1,
                    "balance_already_correct" to 2L,
                ),
            ),
        )
        assertEquals(mapOf("no_total" to 3L, "balance_already_correct" to 2L), report.skipped)
        assertEquals("detect", report.mode)
    }

    @Test
    fun `a nested object decodes even when the wire value is missing`() {
        val updated = decodeUpdateInvoiceResult(mapOf("invoiceId" to "inv1"))
        assertEquals(0L, updated.totals.totalCents)
        assertEquals(0L, updated.totals.paidCents)
    }

    // ── Encoders: the payload contract ───────────────────────────────────────

    @Test
    fun `recordPayment encodes exactly the 13 zod Args keys`() {
        val payload = RecordPaymentArgs(
            kinfolkId = "kf1",
            kinfolkName = "Rosa Parks",
            client = "Rosa P.",
            address = "12 Elm St",
            date = "2026-05-01",
            paymentMethod = "Zelle",
            referenceNumber = "Z-123",
            email = "rosa@example.com",
            amount = 80.0,
            tip = 5.0,
            notes = "May walks",
            invoiceId = "inv1",
            invoiceNumber = "1042",
        ).toPayload()

        assertEquals(
            setOf(
                "kinfolkId", "kinfolkName", "client", "address", "date",
                "paymentMethod", "referenceNumber", "email", "amount", "tip",
                "notes", "invoiceId", "invoiceNumber",
            ),
            payload.keys,
        )
        assertEquals(80.0, payload["amount"])
        assertEquals("Z-123", payload["referenceNumber"])
    }

    @Test
    fun `a defaulted field still ships when left at its default`() {
        // The server would fill the same value in. Sending it keeps the payload
        // one shape whatever the caller does, which is what the hand-written
        // recordPaymentPayload does today.
        val payload = RecordPaymentArgs(amount = 10.0).toPayload()
        assertEquals(13, payload.size)
        assertEquals("", payload["kinfolkId"])
        assertEquals(0.0, payload["tip"])
    }

    @Test
    fun `an optional field with no server default is omitted rather than sent null`() {
        assertEquals(
            setOf("invoiceId"),
            MarkInvoicePaidArgs(invoiceId = "inv1").toPayload().keys,
        )
        assertEquals(
            setOf("invoiceId", "amount", "method"),
            MarkInvoicePaidArgs(invoiceId = "inv1", amount = 20.0, method = "check")
                .toPayload().keys,
        )
    }

    @Test
    fun `a nested request object encodes through its own toPayload`() {
        val payload = UpdateInvoiceArgs(
            invoiceId = "inv1",
            patch = UpdateInvoiceArgsPatch(terms = "Net 30"),
        ).toPayload()

        assertEquals(setOf("invoiceId", "patch"), payload.keys)
        @Suppress("UNCHECKED_CAST")
        val patch = payload["patch"] as Map<String, Any?>
        assertEquals(setOf("terms"), patch.keys)
        assertEquals("Net 30", patch["terms"])
    }

    @Test
    fun `a list of nested request objects encodes element by element`() {
        val payload = CreateInvoiceArgs(
            familyId = "kf1",
            invoiceNumber = "1042",
            total = 40.0,
            amountDue = 40.0,
            lineItems = listOf(
                CreateInvoiceArgsLineItem(description = "Walk", qty = 2.0, unitCents = 2000),
            ),
        ).toPayload()

        @Suppress("UNCHECKED_CAST")
        val lines = payload["lineItems"] as List<Map<String, Any?>>
        assertEquals(1, lines.size)
        // `discountCents` is optional with no server default, so it is absent.
        assertEquals(setOf("description", "qty", "unitCents"), lines[0].keys)
        assertEquals(2000L, lines[0]["unitCents"])
    }
}
