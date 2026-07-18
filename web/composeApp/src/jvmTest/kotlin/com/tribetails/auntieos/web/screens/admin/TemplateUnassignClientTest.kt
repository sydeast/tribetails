package com.tribetails.auntieos.web.screens.admin

import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * AO-56: TemplateService.unassignTemplate routes through platformInvokeCallable,
 * answered on jvm by JvmFirestoreFixtures. The jvm actual is shared with desktop,
 * so this is desktop (JVM) + wasm coverage in one suite: the desktop path reaches
 * the real callable (JvmFirestoreRest.callable) in production.
 */
class TemplateUnassignClientTest {

    @AfterTest
    fun tearDown() { JvmFirestoreFixtures.callableResponses = emptyMap() }

    @Test
    fun unassignSendsCatalogKeyAndDecodesRemovedTrue() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("unassignTemplate" to """{"catalogKey":"booking.confirmed","removed":true}""")
        val r = TemplateService().unassignTemplate("booking.confirmed")
        assertTrue(r is WriteResult.Ok)
        assertEquals(true, (r as WriteResult.Ok).value)
        assertEquals("unassignTemplate", JvmFirestoreFixtures.lastCallableName)
        assertTrue(JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty().contains("booking.confirmed"))
    }

    @Test
    fun unassignDefaultsRemovedFalseWhenMissing() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("unassignTemplate" to """{"catalogKey":"x"}""")
        val r = TemplateService().unassignTemplate("x")
        assertTrue(r is WriteResult.Ok)
        assertEquals(false, (r as WriteResult.Ok).value)
    }

    @Test
    fun unassignMalformedSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("unassignTemplate" to "not-json{")
        val r = TemplateService().unassignTemplate("x")
        assertTrue(r is WriteResult.Err)
    }
}
