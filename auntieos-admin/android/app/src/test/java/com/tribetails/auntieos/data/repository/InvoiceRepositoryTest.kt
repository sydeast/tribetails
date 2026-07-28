package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.data.model.Payment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The [InvoiceRepository] wire contract: every pure encoder and decoder the
 * invoice and payment callables go through. Renamed from InvoiceWriteCallablesTest
 * and gathered here by W4-1, so the contracts sit beside the repo that sends
 * them rather than scattered across the god-file's test files.
 *
 * These payloads are HAND-MIRRORED against the server zod Args (e.g.
 * mytribe/functions/src/admin/recordPayment.ts), so these tests pin the exact
 * key set: a key added or dropped here is contract drift the compiler cannot
 * see. ADR-0001 replaces the mirrors with generated Kotlin; the tests outlive
 * that swap. Kept pure so they run without Firebase static init, like
 * AssignAuntiePayloadTest / StageTwoTailDecodeTest.
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
    fun `recordPayment payload mirrors the zod Args field for field`() {
        val p = recordPaymentPayload(payment)
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
        assertFalse(recordPaymentPayload(payment).containsKey("id"))
    }

    @Test
    fun `recordPayment payload passes the caller's kinfolkId through untouched`() {
        // The old direct write rewrote kinfolkId client-side via
        // TestMode.scopedKinfolkId. The payload must NOT: the sandbox stamp is
        // the server's job now (lib/testMode.ts), so what the caller set is
        // exactly what is sent.
        val standalone = payment.copy(kinfolkId = "", invoiceId = "", invoiceNumber = "")
        val p = recordPaymentPayload(standalone)
        assertEquals("", p["kinfolkId"])
        assertEquals("", p["invoiceId"])
    }

    // ── linkInvoiceSessions result decode ────────────────────────────────────

    @Test
    fun `decodeInvoiceSessionLinks reads the full server payload`() {
        val decoded = decodeInvoiceSessionLinks(
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
    fun `decodeInvoiceSessionLinks falls back to the requested set on a null payload`() {
        // The call succeeded (we only decode after a successful await), so the
        // requested set IS the stored set; duplicates collapse like the server's.
        val decoded = decodeInvoiceSessionLinks(
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
    fun `decodeInvoiceSessionLinks drops non-string entries and tolerates partial payloads`() {
        val decoded = decodeInvoiceSessionLinks(
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
    fun `decodeInvoiceSessionLinks reads an empty stored set as empty, not as the requested fallback`() {
        // `[]` unlinks everything; an explicit empty list from the server must
        // decode as empty rather than falling back to what was requested.
        val decoded = decodeInvoiceSessionLinks(
            mapOf("invoiceId" to "inv1", "sessionIds" to emptyList<String>(), "removed" to listOf("ses1")),
            requestedInvoiceId = "inv1",
            requestedSessionIds = emptyList(),
        )
        assertTrue(decoded.sessionIds.isEmpty())
        assertEquals(listOf("ses1"), decoded.removed)
    }

    // ── sendInvoiceReminder result decode (moved from StageTwoTailDecodeTest) ─
    @Test
    fun `reminder decode echoes server invoiceId`() {
        assertEquals("inv-9", decodeSentReminderInvoiceId(mapOf("ok" to true, "invoiceId" to "inv-9"), "inv-1"))
    }
    @Test
    fun `reminder decode falls back to requested id when missing`() {
        assertEquals("inv-1", decodeSentReminderInvoiceId(mapOf("ok" to true), "inv-1"))
        assertEquals("inv-1", decodeSentReminderInvoiceId(null, "inv-1"))
    }
    @Test
    fun `reminder decode falls back when server id is blank`() {
        assertEquals("inv-1", decodeSentReminderInvoiceId(mapOf("invoiceId" to ""), "inv-1"))
    }
    // ── markInvoicePaid settlement decode (moved from RecordPaymentOutcomeTest) ─
    @Test
    fun `settlement decodes the callable payload into integer cents`() {
        val decoded = decodeInvoiceSettlement(
            mapOf(
                "state" to "partial",
                "totalCents" to 4000,
                "paidCents" to 2000,
                "amountDueCents" to 2000,
                "overpaidCents" to 0,
            ),
        )
        assertEquals("partial", decoded.state)
        assertEquals(2000L, decoded.amountDueCents)
        assertTrue(decoded.isPartial)
    }
    @Test
    fun `an UNREADABLE settlement payload decodes to partial, never to settled`() {
        // If the server's answer cannot be read, the safe reading is that money
        // may still be owed: that keeps the invoice in Outstanding and keeps the
        // operator able to collect. Defaulting to settled would reproduce the
        // very defect this decode exists to prevent, in the client.
        assertTrue(decodeInvoiceSettlement(null).isPartial)
        assertTrue(decodeInvoiceSettlement(emptyMap()).isPartial)
        assertTrue(decodeInvoiceSettlement(mapOf("state" to "")).isPartial)
    }
    @Test
    fun `a missing cents field decodes to zero rather than throwing`() {
        val decoded = decodeInvoiceSettlement(mapOf("state" to "settled"))
        assertEquals(0L, decoded.amountDueCents)
        assertEquals(0L, decoded.overpaidCents)
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
