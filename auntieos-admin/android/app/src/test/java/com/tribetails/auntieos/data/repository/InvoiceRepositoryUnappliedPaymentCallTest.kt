package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1003: THE WIRE for `listUnappliedPayments` and `resolveUnappliedPayment`.
 * The controller tests mock the repository, so a misspelled callable name or a
 * field sent under the wrong name would pass all of them.
 */
class InvoiceRepositoryUnappliedPaymentCallTest {

    private fun repoWith(functions: FirebaseFunctions) =
        InvoiceRepository(authGate = mockk(relaxed = true), functionsProvider = { functions })

    private fun wire(name: String, response: Any?): Pair<FirebaseFunctions, io.mockk.CapturingSlot<Any>> {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        val payload = slot<Any>()
        every { callResult.getData() } returns response
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable(name) } returns ref
        return functions to payload
    }

    @Test
    fun `listUnappliedPayments names the household and decodes payments and open invoices`() = runBlocking {
        val (functions, payload) = wire(
            "listUnappliedPayments",
            mapOf(
                "ok" to true,
                "kinfolkId" to "fam1",
                "payments" to listOf(
                    mapOf(
                        "paymentId" to "evt_1",
                        "kinfolkId" to "fam1",
                        "invoiceId" to "inv42",
                        "invoiceNumber" to "INV-1042",
                        "amountCents" to 2500,
                        "amountResolved" to true,
                        "feeCents" to 103,
                        "reason" to "the invoice was already marked paid",
                        "receivedAtMs" to 1_790_000_000_000L,
                        "referenceNumber" to "pi_123",
                    ),
                ),
                "openInvoices" to listOf(
                    mapOf("invoiceId" to "inv50", "invoiceNumber" to "INV-1050", "amountDueCents" to 4000),
                ),
            ),
        )

        val res = repoWith(functions).listUnappliedPayments("fam1").getOrThrow()

        assertEquals(mapOf("kinfolkId" to "fam1"), payload.captured)
        val p = res.payments.single()
        assertEquals("evt_1", p.paymentId)
        assertEquals(2500L, p.amountCents)
        assertTrue(p.amountResolved)
        assertEquals("INV-1042", p.invoiceNumber)
        assertEquals(4000L, res.openInvoices.single().amountDueCents)
    }

    @Test
    fun `listUnappliedPayments fails on a reply the server did not mark ok`() = runBlocking {
        val (functions, _) = wire("listUnappliedPayments", mapOf("payments" to emptyList<Any>()))
        assertTrue(repoWith(functions).listUnappliedPayments("fam1").isFailure)
    }

    @Test
    fun `resolveUnappliedPayment sends every field under its own name, as integer cents`() = runBlocking {
        val (functions, payload) = wire(
            "resolveUnappliedPayment",
            mapOf(
                "ok" to true,
                "paymentId" to "evt_1",
                "kinfolkId" to "fam1",
                "paymentCents" to 2500,
                "creditedCents" to 1000,
                "creditId" to "upd_1790000000000_abc123",
                "appliedCents" to 1500,
                "appliedInvoiceId" to "inv50",
                "appliedInvoiceNumber" to "INV-1050",
                "appliedInvoiceState" to "partial",
                "appliedInvoiceAmountDueCents" to 2500,
                "keptCents" to 0,
                "newAccountBalanceCents" to 3700,
                "replayed" to false,
            ),
        )

        val res = repoWith(functions)
            .resolveUnappliedPayment("evt_1", 1000L, "Overpaid", "inv50", 1500L, "upd_1790000000000_abc123")
            .getOrThrow()

        assertEquals(
            mapOf(
                "paymentId" to "evt_1",
                "creditCents" to 1000L,
                "creditReason" to "Overpaid",
                "applyInvoiceId" to "inv50",
                "applyCents" to 1500L,
                "idempotencyKey" to "upd_1790000000000_abc123",
            ),
            payload.captured,
        )
        assertEquals(1000L, res.creditedCents)
        assertEquals(1500L, res.appliedCents)
        assertEquals("partial", res.appliedInvoiceState)
        assertEquals(3700L, res.newAccountBalanceCents)
        assertFalse(res.replayed)
    }

    @Test
    fun `resolveUnappliedPayment sends the all-zero keep decision with empty strings`() = runBlocking {
        val (functions, payload) = wire("resolveUnappliedPayment", mapOf("ok" to true, "keptCents" to 2500))
        repoWith(functions).resolveUnappliedPayment("evt_1", 0L, "", "", 0L, "upd_1790000000000_z").getOrThrow()
        assertEquals(
            mapOf(
                "paymentId" to "evt_1",
                "creditCents" to 0L,
                "creditReason" to "",
                "applyInvoiceId" to "",
                "applyCents" to 0L,
                "idempotencyKey" to "upd_1790000000000_z",
            ),
            payload.captured,
        )
    }

    @Test
    fun `resolveUnappliedPayment fails rather than reporting a decision the server did not confirm`() = runBlocking {
        val (functions, _) = wire("resolveUnappliedPayment", mapOf("creditedCents" to 1000))
        assertTrue(
            repoWith(functions).resolveUnappliedPayment("evt_1", 1000L, "r", "", 0L, "upd_1790000000000_a").isFailure,
        )
    }
}
