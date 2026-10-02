package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1102: FirestoreClient.listMessageSuppressions / clearMessageSuppression route
 * through platformInvokeCallable (the path every desktop callable uses), answered
 * on jvm by JvmFirestoreFixtures. Pins the callable names, the request bodies and
 * the decode.
 */
class MessageSuppressionClientTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    @Test
    fun listSendsReasonAndCursorAndDecodesRows() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listMessageSuppressions" to """{"items":[
              {"recipient":"jane@example.com","recipientRedacted":"j***@example.com","channel":"email","reason":"hard_bounce","source":"smtp2go","suppressedAtMs":1700000000000,"optedOut":true,"eventId":"ev1"},
              {"recipient":"+15551234567","recipientRedacted":"+1******4567","channel":"sms","reason":"opt_out","source":"admin","suppressedAtMs":1700000000001},
              {"recipientRedacted":"no address, dropped"}
            ],"nextCursor":"c2"}""",
        )
        val r = FirestoreClient().listMessageSuppressions("hard_bounce", "c1")
        assertEquals("listMessageSuppressions", JvmFirestoreFixtures.lastCallableName)
        val sent = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals("hard_bounce", sent["reason"]!!.jsonPrimitive.content)
        assertEquals("c1", sent["cursor"]!!.jsonPrimitive.content)
        val page = (r as WriteResult.Ok).value
        assertEquals("c2", page.nextCursor)
        assertEquals(2, page.items.size)
        assertTrue(page.items[0].clearable)
        assertTrue(page.items[0].optedOut)
        assertEquals("ev1", page.items[0].eventId)
        // An opt-out only row is not clearable, and is an opt-out by definition.
        assertFalse(page.items[1].clearable)
        assertTrue(page.items[1].optedOut)
        assertEquals("sms", page.items[1].channel)
        assertNull(page.items[1].eventId)
    }

    @Test
    fun listOmitsTheCursorOnTheFirstPage() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("listMessageSuppressions" to """{"items":[]}""")
        FirestoreClient().listMessageSuppressions("all")
        val sent = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertFalse(sent.containsKey("cursor"))
        assertEquals("all", sent["reason"]!!.jsonPrimitive.content)
    }

    @Test
    fun listMalformedJsonSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("listMessageSuppressions" to "not-json{")
        assertTrue(FirestoreClient().listMessageSuppressions("all") is WriteResult.Err)
    }

    @Test
    fun clearSendsTheFullAddressAndDecodesOptOutKept() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "clearMessageSuppression" to """{"ok":true,"channel":"email","recipientRedacted":"j***@example.com","optOutKept":true}""",
        )
        val r = FirestoreClient().clearMessageSuppression("  jane@example.com ")
        assertEquals("clearMessageSuppression", JvmFirestoreFixtures.lastCallableName)
        val sent = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals("jane@example.com", sent["recipient"]!!.jsonPrimitive.content)
        val v = (r as WriteResult.Ok).value
        assertTrue(v.optOutKept)
        assertEquals("j***@example.com", v.recipientRedacted)
    }

    @Test
    fun clearServerErrorPassesThrough() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("clearMessageSuppression" to "permission-denied")
        val r = FirestoreClient().clearMessageSuppression("jane@example.com")
        assertEquals("permission-denied", (r as WriteResult.Err).message)
    }
}
