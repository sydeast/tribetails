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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Q6: THE WIRE for `giveAccountCredit` and `getAccountCreditHistory`. The screen
 * tests mock the repository, so a misspelled callable name or a key sent under
 * the wrong name would pass all of them.
 */
class InvoiceRepositoryAccountCreditCallTest {

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
    fun `giveAccountCredit sends integer cents, the reason and the key, and decodes the server balance`() = runBlocking {
        val (functions, payload) = wire(
            "giveAccountCredit",
            mapOf(
                "ok" to true,
                "creditId" to "crd_1790000000000_abc123",
                "amountCents" to 2500,
                "newAccountBalanceCents" to 3700,
                "replayed" to false,
            ),
        )

        val res = repoWith(functions)
            .giveAccountCredit("fam1", 2500L, "Missed visit", "crd_1790000000000_abc123")
            .getOrThrow()

        assertEquals(
            mapOf(
                "kinfolkId" to "fam1",
                "amountCents" to 2500L,
                "reason" to "Missed visit",
                "idempotencyKey" to "crd_1790000000000_abc123",
            ),
            payload.captured,
        )
        assertEquals(3700L, res.newAccountBalanceCents)
        assertEquals("crd_1790000000000_abc123", res.creditId)
        assertFalse(res.replayed)
    }

    @Test
    fun `giveAccountCredit fails rather than reporting a credit the server did not confirm`() = runBlocking {
        val (functions, _) = wire("giveAccountCredit", mapOf("creditId" to "x"))
        assertTrue(repoWith(functions).giveAccountCredit("fam1", 1L, "r", "crd_1790000000000_a").isFailure)
    }

    @Test
    fun `getAccountCreditHistory names the household and decodes credits and uses`() = runBlocking {
        val (functions, payload) = wire(
            "getAccountCreditHistory",
            mapOf(
                "ok" to true,
                "kinfolkId" to "fam1",
                "accountBalanceCents" to 1000,
                "credits" to listOf(
                    mapOf(
                        "creditId" to "crd_1",
                        "amountCents" to 2500,
                        "reason" to "Missed visit",
                        "givenAtMs" to 1000L,
                        "remainingCents" to 0,
                        "fullyAppliedAtMs" to 2000L,
                        "applications" to listOf(
                            mapOf("appliedAtMs" to 2000L, "amountCents" to 2500, "invoiceId" to "inv9", "invoiceNumber" to "INV-1009"),
                        ),
                    ),
                    mapOf(
                        "creditId" to "crd_2",
                        "amountCents" to 1000,
                        "reason" to "Goodwill",
                        "givenAtMs" to 3000L,
                        "remainingCents" to 1000,
                        "fullyAppliedAtMs" to null,
                        "applications" to emptyList<Any>(),
                    ),
                ),
                "uses" to listOf(
                    mapOf("useId" to "draw_p1", "usedAtMs" to 2000L, "amountCents" to 2500, "invoiceId" to "inv9", "invoiceNumber" to null),
                ),
            ),
        )

        val res = repoWith(functions).getAccountCreditHistory("fam1").getOrThrow()

        assertEquals(mapOf("kinfolkId" to "fam1"), payload.captured)
        assertEquals(1000L, res.accountBalanceCents)
        assertEquals(listOf("crd_1", "crd_2"), res.credits.map { it.creditId })
        assertEquals(2000L, res.credits[0].fullyAppliedAtMs)
        assertEquals("INV-1009", res.credits[0].applications.single().invoiceNumber)
        assertNull(res.credits[1].fullyAppliedAtMs)
        assertNull(res.uses.single().invoiceNumber)
    }
}
