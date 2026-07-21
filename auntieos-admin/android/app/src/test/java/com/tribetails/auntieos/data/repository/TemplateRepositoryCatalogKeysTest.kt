package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Stage 2 tail: TemplateRepository.listCatalogKeys wraps the read-only listCatalogKeys
 * callable. These verify the keys decode, the empty/missing fallback, and fail-loud
 * propagation. Plus the pure unboundCatalogKeys diff that drives the hint panel.
 * FirebaseFunctions is fully mocked, so no network or Android static init is required.
 */
class TemplateRepositoryCatalogKeysTest {

    private fun repoWith(functions: FirebaseFunctions) = TemplateRepository(functions = functions)

    @Test
    fun `listCatalogKeys decodes the keys array`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf("keys" to listOf("invoice.new", "kincare.booking.confirm"))
        every { ref.call(any()) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("listCatalogKeys") } returns ref

        val result = repoWith(functions).listCatalogKeys()
        assertTrue(result.isSuccess)
        assertEquals(listOf("invoice.new", "kincare.booking.confirm"), result.getOrNull())
    }

    @Test
    fun `listCatalogKeys defaults to empty when keys missing`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf("ok" to true)
        every { ref.call(any()) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("listCatalogKeys") } returns ref

        val result = repoWith(functions).listCatalogKeys()
        assertTrue(result.isSuccess)
        assertEquals(emptyList<String>(), result.getOrNull())
    }

    @Test
    fun `listCatalogKeys propagates fail-loud message`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns Tasks.forException(RuntimeException("permission-denied: admin only"))
        every { functions.getHttpsCallable("listCatalogKeys") } returns ref

        val result = repoWith(functions).listCatalogKeys()
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("admin only"))
    }

    // ── pure unbound diff ─────────────────────────────────────────────────────────

    @Test fun `unbound keys are catalog minus bound, sorted, deduped`() {
        val catalog = listOf("invoice.new", "kincare.booking.confirm", "invoice.reminder")
        val bound = listOf("invoice.new")
        assertEquals(
            listOf("invoice.reminder", "kincare.booking.confirm"),
            unboundCatalogKeys(catalog, bound),
        )
    }

    @Test fun `unbound keys is empty when everything is bound`() {
        val catalog = listOf("a", "b")
        assertEquals(emptyList<String>(), unboundCatalogKeys(catalog, listOf("a", "b")))
    }

    @Test fun `unbound keys drops blanks on both sides`() {
        val catalog = listOf("a", "", "b")
        val bound = listOf("", "a")
        assertEquals(listOf("b"), unboundCatalogKeys(catalog, bound))
    }
}
