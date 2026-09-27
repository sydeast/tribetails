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
 * #965: `listTemplateBindings` used to decode a doc with no `active` field as
 * OFF (`?: false`), while dispatch (`resolveTemplateId`, functions side)
 * already treated the same missing field as ON. These pin the fixed decode
 * (`isBindingActive`) and its use inside `TemplateRepository.listBindings`.
 * FirebaseFunctions is fully mocked; no network or Android static init.
 */
class TemplateRepositoryBindingsTest {

    private fun repoWith(functions: FirebaseFunctions) = TemplateRepository(functions = functions)

    private fun functionsReturning(data: Any?): FirebaseFunctions {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns data
        every { ref.call(any()) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("listTemplateBindings") } returns ref
        return functions
    }

    @Test
    fun `a binding with no active field decodes as active`() = runBlocking {
        val functions = functionsReturning(
            mapOf(
                "bindings" to listOf(
                    mapOf("catalogKey" to "booking.confirmed", "templateId" to "tmpl_custom"),
                ),
            ),
        )
        val result = repoWith(functions).listBindings()
        assertTrue(result.isSuccess)
        assertTrue(result.getOrNull()!!.single().active)
    }

    @Test
    fun `a binding with active=false decodes as paused`() = runBlocking {
        val functions = functionsReturning(
            mapOf(
                "bindings" to listOf(
                    mapOf("catalogKey" to "invoice.new", "templateId" to "tmpl_custom", "active" to false),
                ),
            ),
        )
        val result = repoWith(functions).listBindings()
        assertFalse(result.getOrNull()!!.single().active)
    }

    @Test
    fun `a binding with active=true decodes as active`() = runBlocking {
        val functions = functionsReturning(
            mapOf(
                "bindings" to listOf(
                    mapOf("catalogKey" to "invoice.reminder", "templateId" to "tmpl_custom", "active" to true),
                ),
            ),
        )
        val result = repoWith(functions).listBindings()
        assertTrue(result.getOrNull()!!.single().active)
    }

    @Test
    fun `listBindings defaults to empty when the bindings field is missing`() = runBlocking {
        val result = repoWith(functionsReturning(mapOf("ok" to true))).listBindings()
        assertTrue(result.isSuccess)
        assertEquals(emptyList<TemplateRepository.TemplateBinding>(), result.getOrNull())
    }

    @Test
    fun `isBindingActive treats only a literal false as paused`() {
        assertTrue(isBindingActive(null))
        assertTrue(isBindingActive(true))
        assertFalse(isBindingActive(false))
    }

    // ── #965: toggling a binding must write an explicit value, never rely on ──
    // ── Firestore's missing-field default matching the caller's own guess. ────

    @Test
    fun `assignTemplate with the default active sends an explicit true, not an omitted field`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        val payload = slot<Map<String, Any>>()
        every { callResult.getData() } returns mapOf("catalogKey" to "invoice.new", "templateId" to "t1", "active" to true)
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("assignTemplate") } returns ref

        // The caller (BindingEditorDialog) never omits `active`, it always sends
        // the toggle's current state, but the repository default still matters
        // for a fresh (unbound) key opened straight to Save.
        val result = repoWith(functions).assignTemplate(catalogKey = "invoice.new", templateId = "t1")
        assertTrue(result.isSuccess)
        assertEquals(true, payload.captured["active"])
        assertTrue("active" in payload.captured)
    }

    @Test
    fun `assignTemplate with active=false sends an explicit false, never dropped`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        val payload = slot<Map<String, Any>>()
        every { callResult.getData() } returns mapOf("catalogKey" to "invoice.new", "templateId" to "t1", "active" to false)
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("assignTemplate") } returns ref

        val result = repoWith(functions).assignTemplate(catalogKey = "invoice.new", templateId = "t1", active = false)
        assertTrue(result.isSuccess)
        assertEquals(false, payload.captured["active"])
    }
}
