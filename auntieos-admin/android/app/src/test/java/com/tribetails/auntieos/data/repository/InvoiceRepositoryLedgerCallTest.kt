package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE WIRE, for `InvoiceRepository.getInvoiceLedger`.
 *
 * Every other test of this change mocks the REPOSITORY, so all of them would
 * still pass if the callable name were misspelled, the argument were sent under
 * the wrong key, or the new `unlinkedKinfolkPayments` list were dropped on
 * decode — and the invoice screen would simply be blank in production. Those are
 * exactly the failures a repo-level mock cannot see, so they are pinned here,
 * against a mocked `FirebaseFunctions` (no network, no Android static init,
 * same shape as `TemplateRepositoryCatalogKeysTest`).
 *
 * The units assertions matter for a reason beyond arithmetic: they pin that the
 * client does NO unit math at all. `13750` goes out of the server as cents and
 * arrives as `13750`. The moment this decode starts adjusting a figure, the
 * Kotlin copy of the money rule that Option A was rejected for is back.
 */
class InvoiceRepositoryLedgerCallTest {

    /** A relaxed gate: these cases are about the wire, not about sign-in. */
    private fun repoWith(functions: FirebaseFunctions) =
        InvoiceRepository(authGate = mockk(relaxed = true), functionsProvider = { functions })

    private fun ledgerRow(
        paymentId: String,
        amountCents: Long,
        method: String = "stripe",
    ): Map<String, Any?> = mapOf(
        "paymentId" to paymentId,
        "amountCents" to amountCents,
        "tipCents" to 0L,
        "feeCents" to 0L,
        "tipBasis" to "gross",
        "reconciles" to true,
        "appliedCents" to 0L,
        "unappliedCents" to amountCents,
        "proceedsCents" to amountCents,
        "autoApply" to false,
        "appliedInvoiceId" to "",
        "appliedInvoiceNumber" to "",
        "method" to method,
        "reference" to "",
        "date" to "2026-07-20",
        "notes" to "",
        "recordedBy" to null,
    )

    @Test
    fun `it calls getInvoiceLedger by name and sends the invoice id under invoiceId`() =
        runBlocking {
            val functions = mockk<FirebaseFunctions>()
            val ref = mockk<HttpsCallableReference>()
            val callResult = mockk<HttpsCallableResult>(relaxed = true)
            val payload = slot<Any>()
            every { callResult.getData() } returns mapOf("invoiceId" to "inv1")
            every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
            every { functions.getHttpsCallable("getInvoiceLedger") } returns ref

            val result = repoWith(functions).getInvoiceLedger("inv1")

            assertTrue(result.isSuccess)
            // The name is the whole contract with the server; a typo here is a
            // production-only failure no repo-mocked test can reach.
            verify(exactly = 1) { functions.getHttpsCallable("getInvoiceLedger") }
            @Suppress("UNCHECKED_CAST")
            val sent = payload.captured as Map<String, Any?>
            assertEquals(setOf("invoiceId"), sent.keys)
            assertEquals("inv1", sent["invoiceId"])
        }

    @Test
    fun `both payment lists decode, and the cents the server sent arrive unchanged`() =
        runBlocking {
            // 13750 is what `stripeWebhook.ts` stored for a $137.50 card payment.
            // The server has already resolved it to cents; this client's ONLY job
            // is to not touch it.
            val functions = mockk<FirebaseFunctions>()
            val ref = mockk<HttpsCallableReference>()
            val callResult = mockk<HttpsCallableResult>(relaxed = true)
            every { callResult.getData() } returns mapOf(
                "invoiceId" to "inv1",
                "payments" to emptyList<Any?>(),
                "paidCents" to 13750L,
                "totalCents" to 20000L,
                "amountDueCents" to 6250L,
                "ledgerPayments" to listOf(ledgerRow("evt_1", 13750L)),
                "unlinkedKinfolkPayments" to listOf(ledgerRow("pay_2", 6000L, "Venmo")),
                "sessions" to emptyList<Any?>(),
                "missingSessionIds" to emptyList<Any?>(),
                "orphanSessionIds" to emptyList<Any?>(),
                "truncated" to false,
            )
            every { ref.call(any()) } returns Tasks.forResult(callResult)
            every { functions.getHttpsCallable("getInvoiceLedger") } returns ref

            val ledger = repoWith(functions).getInvoiceLedger("inv1").getOrThrow()

            assertEquals(listOf("evt_1"), ledger.ledgerPayments.map { it.paymentId })
            assertEquals(13750L, ledger.ledgerPayments.single().amountCents)
            // The list the client used to build itself out of a raw root-collection
            // read. If a decode change ever drops it, the "NOT INVOICE-LINKED"
            // panel silently empties rather than failing.
            assertEquals(listOf("pay_2"), ledger.unlinkedKinfolkPayments.map { it.paymentId })
            assertEquals(6000L, ledger.unlinkedKinfolkPayments.single().amountCents)
            assertEquals("Venmo", ledger.unlinkedKinfolkPayments.single().method)
            assertEquals(6250L, ledger.amountDueCents)
        }

    @Test
    fun `a blank invoice id is refused before anything goes on the wire`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()

        val result = repoWith(functions).getInvoiceLedger("  ")

        assertTrue(result.isFailure)
        verify(exactly = 0) { functions.getHttpsCallable(any()) }
    }

    @Test
    fun `a failed call surfaces as a failure, never as an empty ledger`() = runBlocking {
        // Fail-loud, and specifically NOT fail-soft: an empty success here would
        // read on screen as "this invoice has no payments", which is a false
        // statement about money rather than a missing one.
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns
            Tasks.forException(RuntimeException("unavailable: getInvoiceLedger"))
        every { functions.getHttpsCallable("getInvoiceLedger") } returns ref

        val result = repoWith(functions).getInvoiceLedger("inv1")

        assertTrue(result.isFailure)
        assertFalse(result.isSuccess)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("unavailable"))
    }
}
