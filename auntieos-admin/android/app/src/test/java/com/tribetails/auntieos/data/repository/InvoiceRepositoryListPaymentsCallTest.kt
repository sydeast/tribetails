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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE WIRE, for `InvoiceRepository.listPayments`.
 *
 * The screen-level tests mock the repository, so all of them would still pass
 * if the callable name were misspelled, the page arguments went out under the
 * wrong keys, or the truncation signal were dropped on decode. Those are
 * production-only failures a repo-level mock cannot see.
 *
 * The units assertions pin that the client does NO unit math. `13750` leaves
 * the server as cents and arrives as `13750`. The moment this decode starts
 * adjusting a figure, the Kotlin copy of the money rule this whole design
 * exists to avoid is back.
 */
class InvoiceRepositoryListPaymentsCallTest {

    /** A relaxed gate: these cases are about the wire, not about sign-in. */
    private fun repoWith(functions: FirebaseFunctions) =
        InvoiceRepository(authGate = mockk(relaxed = true), functionsProvider = { functions })

    private fun row(
        paymentId: String,
        amountCents: Long,
        amountResolved: Boolean = true,
    ): Map<String, Any?> = mapOf(
        "paymentId" to paymentId,
        "kinfolkId" to "fam1",
        "kinfolkName" to "The Alvarez Tribe",
        "amountCents" to amountCents,
        "amountResolved" to amountResolved,
        "tipCents" to 1000L,
        "feeCents" to 271L,
        "tipBasis" to "gross",
        "reconciles" to true,
        "appliedCents" to 0L,
        "unappliedCents" to amountCents - 1000L,
        "proceedsCents" to amountCents - 271L,
        "autoApply" to false,
        "invoiceId" to "",
        "invoiceNumber" to "",
        "appliedInvoiceId" to "",
        "appliedInvoiceNumber" to "",
        "method" to "stripe",
        "reference" to "",
        "date" to "",
        "notes" to "",
        "recordedBy" to null,
    )

    @Test
    fun `it calls listPayments by name and sends no page arguments by default`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        val payload = slot<Any>()
        every { callResult.getData() } returns mapOf(
            "payments" to emptyList<Any?>(),
            "truncated" to false,
            "nextCursor" to null,
            "unresolvedAmountCount" to 0L,
        )
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("listPayments") } returns ref

        val result = repoWith(functions).listPayments()

        assertTrue(result.isSuccess)
        // The name is the whole contract with the server; a typo here is a
        // production-only failure no repo-mocked test can reach.
        verify(exactly = 1) { functions.getHttpsCallable("listPayments") }
        @Suppress("UNCHECKED_CAST")
        val sent = payload.captured as Map<String, Any?>
        // The server's `Args` is `.strict()`: an argument it does not know about
        // is a rejected call, so the payload carries only what was asked for.
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `it sends the page size and the resume cursor under the server's own keys`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        val payload = slot<Any>()
        every { callResult.getData() } returns mapOf(
            "payments" to emptyList<Any?>(),
            "truncated" to false,
            "nextCursor" to null,
            "unresolvedAmountCount" to 0L,
        )
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("listPayments") } returns ref

        repoWith(functions).listPayments(limit = 25, startAfterId = "pay_7").getOrThrow()

        @Suppress("UNCHECKED_CAST")
        val sent = payload.captured as Map<String, Any?>
        assertEquals(setOf("limit", "startAfterId"), sent.keys)
        assertEquals(25L, sent["limit"])
        assertEquals("pay_7", sent["startAfterId"])
    }

    @Test
    fun `the cents the server resolved arrive unchanged, and so does the unresolved flag`() =
        runBlocking {
            // 13750 is what `stripeWebhook.ts` stored for a $137.50 card payment.
            // The server has already resolved it; this client's ONLY job is to
            // not touch it.
            val functions = mockk<FirebaseFunctions>()
            val ref = mockk<HttpsCallableReference>()
            val callResult = mockk<HttpsCallableResult>(relaxed = true)
            every { callResult.getData() } returns mapOf(
                "payments" to listOf(row("evt_1", 13750L), row("evt_2", 0L, amountResolved = false)),
                "truncated" to false,
                "nextCursor" to null,
                "unresolvedAmountCount" to 1L,
            )
            every { ref.call(any()) } returns Tasks.forResult(callResult)
            every { functions.getHttpsCallable("listPayments") } returns ref

            val page = repoWith(functions).listPayments().getOrThrow()

            assertEquals(listOf("evt_1", "evt_2"), page.payments.map { it.paymentId })
            assertEquals(13750L, page.payments.first().amountCents)
            assertTrue(page.payments.first().amountResolved)
            // A row whose units could not be read arrives flagged. Its 0 is the
            // schema floor, NOT a payment of nothing, and this flag is the only
            // thing that says so.
            assertFalse(page.payments[1].amountResolved)
            assertEquals(1L, page.unresolvedAmountCount)
        }

    @Test
    fun `a bounded page arrives bounded, with the cursor to continue`() = runBlocking {
        // The failure this whole contract exists to prevent: a short list that
        // reads as a complete one.
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf(
            "payments" to listOf(row("evt_1", 100L)),
            "truncated" to true,
            "nextCursor" to "evt_1",
            "unresolvedAmountCount" to 0L,
        )
        every { ref.call(any()) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("listPayments") } returns ref

        val page = repoWith(functions).listPayments(limit = 1).getOrThrow()

        assertTrue(page.truncated)
        assertEquals("evt_1", page.nextCursor)
    }

    @Test
    fun `a complete page reports no cursor`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf(
            "payments" to listOf(row("evt_1", 100L)),
            "truncated" to false,
            "nextCursor" to null,
            "unresolvedAmountCount" to 0L,
        )
        every { ref.call(any()) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("listPayments") } returns ref

        val page = repoWith(functions).listPayments().getOrThrow()

        assertFalse(page.truncated)
        assertNull(page.nextCursor)
    }

    @Test
    fun `a failed call surfaces as a failure, never as an empty page`() = runBlocking {
        // Fail-loud, and specifically NOT fail-soft. An empty success would read
        // on screen as "no payments have ever been recorded", which is a false
        // statement about money rather than a missing one — and there is no
        // fallback to the raw root-collection read, because that fallback would
        // restore the 100x defect on exactly the days the callable is unhealthy.
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns
            Tasks.forException(RuntimeException("unavailable: listPayments"))
        every { functions.getHttpsCallable("listPayments") } returns ref

        val result = repoWith(functions).listPayments()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("unavailable"))
    }

    @Test
    fun `a non-positive page size is refused before anything goes on the wire`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()

        val result = repoWith(functions).listPayments(limit = 0)

        assertTrue(result.isFailure)
        verify(exactly = 0) { functions.getHttpsCallable(any()) }
    }
}
