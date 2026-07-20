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
 * AO-56: TemplateRepository.unassignTemplate wraps the unassignTemplate callable.
 * Verifies the payload, the removed-flag decode, the idempotent default, and
 * fail-loud propagation. FirebaseFunctions is mocked; no network/Android init.
 */
class TemplateRepositoryUnassignTest {

    private fun repoWith(functions: FirebaseFunctions) = TemplateRepository(functions = functions)

    @Test
    fun `unassignTemplate sends the catalogKey and decodes removed=true`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        val payload = slot<Map<String, Any>>()
        every { callResult.getData() } returns mapOf("catalogKey" to "booking.confirmed", "removed" to true)
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("unassignTemplate") } returns ref

        val result = repoWith(functions).unassignTemplate("booking.confirmed")
        assertTrue(result.isSuccess)
        assertEquals(true, result.getOrNull())
        assertEquals("booking.confirmed", payload.captured["catalogKey"])
    }

    @Test
    fun `unassignTemplate defaults removed=false when the flag is missing`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf("catalogKey" to "x")
        every { ref.call(any()) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("unassignTemplate") } returns ref

        val result = repoWith(functions).unassignTemplate("x")
        assertTrue(result.isSuccess)
        assertFalse(result.getOrNull()!!)
    }

    @Test
    fun `unassignTemplate propagates fail-loud message`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns Tasks.forException(RuntimeException("permission-denied: admin only"))
        every { functions.getHttpsCallable("unassignTemplate") } returns ref

        val result = repoWith(functions).unassignTemplate("x")
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("admin only"))
    }
}
