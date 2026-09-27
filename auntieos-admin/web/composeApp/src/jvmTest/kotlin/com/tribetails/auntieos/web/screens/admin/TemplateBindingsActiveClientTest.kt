package com.tribetails.auntieos.web.screens.admin

import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #965: TemplateService.listBindings used to decode a `notificationTemplateBindings`
 * row with no `active` field as OFF (`?: false`), while dispatch
 * (`resolveTemplateId`, functions side) already treats the same missing field
 * as ON. Routes through platformInvokeCallable, answered on jvm by
 * JvmFirestoreFixtures: the jvm actual is shared with desktop, so this is
 * desktop (JVM) + wasm coverage in one suite.
 */
class TemplateBindingsActiveClientTest {

    @AfterTest
    fun tearDown() { JvmFirestoreFixtures.callableResponses = emptyMap() }

    @Test
    fun aBindingWithNoActiveFieldDecodesAsActive() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listTemplateBindings" to
                """{"bindings":[{"catalogKey":"booking.confirmed","templateId":"tmpl_custom"}]}""",
        )
        val r = TemplateService().listBindings()
        assertTrue(r is WriteResult.Ok)
        assertTrue((r as WriteResult.Ok).value.single().active)
    }

    @Test
    fun aBindingWithActiveFalseDecodesAsPaused() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listTemplateBindings" to
                """{"bindings":[{"catalogKey":"invoice.new","templateId":"tmpl_custom","active":false}]}""",
        )
        val r = TemplateService().listBindings()
        assertTrue(r is WriteResult.Ok)
        assertFalse((r as WriteResult.Ok).value.single().active)
    }

    @Test
    fun aBindingWithActiveTrueDecodesAsActive() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listTemplateBindings" to
                """{"bindings":[{"catalogKey":"invoice.reminder","templateId":"tmpl_custom","active":true}]}""",
        )
        val r = TemplateService().listBindings()
        assertTrue(r is WriteResult.Ok)
        assertTrue((r as WriteResult.Ok).value.single().active)
        assertEquals("listTemplateBindings", JvmFirestoreFixtures.lastCallableName)
    }

    // ── #965: toggling a binding must write an explicit value, never rely on ──
    // ── Firestore's missing-field default matching whatever the caller assumed. ──

    @Test
    fun assignTemplateWithTheDefaultActiveSendsAnExplicitTrue() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("assignTemplate" to "{}")
        TemplateService().assignTemplate(catalogKey = "invoice.new", templateId = "t1")
        assertEquals("assignTemplate", JvmFirestoreFixtures.lastCallableName)
        assertTrue(JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty().contains(""""active":true"""))
    }

    @Test
    fun assignTemplateWithActiveFalseSendsAnExplicitFalseNeverDropped() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("assignTemplate" to "{}")
        TemplateService().assignTemplate(catalogKey = "invoice.new", templateId = "t1", active = false)
        assertTrue(JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty().contains(""""active":false"""))
    }
}
