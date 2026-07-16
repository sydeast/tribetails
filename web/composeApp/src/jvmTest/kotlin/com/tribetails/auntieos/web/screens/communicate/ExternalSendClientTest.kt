package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Stage 2 step 5 integration: FirestoreClient.sendExternalMessage /
 * suppressExternalRecipient route through platformInvokeCallable, answered on jvm
 * by JvmFirestoreFixtures.callableResponses. Covers happy, decode-failure, and
 * (via a fixture that omits fields) the safe-blank path. Also covers desktop
 * (same jvm actual). The opted-out sad path is exercised by the pure error-mapping
 * unit test (the fixture seam returns Ok, so it cannot model an HttpsError throw).
 */
class ExternalSendClientTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.callableResponses = emptyMap()
    }

    @Test
    fun sendExternalEmailHappyPathDecodesRedactedRecipient() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "sendExternalMessage" to """{"ok":true,"channel":"email","providerMessageId":"sg_42","recipientRedacted":"j***@example.com"}""",
        )
        val r = FirestoreClient().sendExternalMessage("email", "jane@example.com", "Hello", "Body")
        assertTrue(r is WriteResult.Ok)
        val v = (r as WriteResult.Ok).value
        assertEquals("email", v.channel)
        assertEquals("sg_42", v.providerMessageId)
        assertEquals("j***@example.com", v.recipientRedacted)
    }

    @Test
    fun sendExternalSmsHappyPath() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "sendExternalMessage" to """{"ok":true,"channel":"sms","providerMessageId":"SM1","recipientRedacted":"+1******7890"}""",
        )
        val r = FirestoreClient().sendExternalMessage("sms", "+15551234567", null, "Body")
        assertTrue(r is WriteResult.Ok)
        assertEquals("sms", (r as WriteResult.Ok).value.channel)
    }

    @Test
    fun sendExternalMissingFieldsDecodeToBlankNotCrash() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("sendExternalMessage" to """{"ok":true}""")
        val r = FirestoreClient().sendExternalMessage("email", "jane@example.com", "Hi", "Body")
        assertTrue(r is WriteResult.Ok)
        assertEquals("", (r as WriteResult.Ok).value.providerMessageId)
    }

    @Test
    fun sendExternalMalformedJsonSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("sendExternalMessage" to "not-json{")
        val r = FirestoreClient().sendExternalMessage("email", "jane@example.com", "Hi", "Body")
        assertTrue(r is WriteResult.Err)
    }

    @Test
    fun suppressExternalRecipientHappyPath() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "suppressExternalRecipient" to """{"ok":true,"channel":"email","recipientRedacted":"j***@example.com"}""",
        )
        val r = FirestoreClient().suppressExternalRecipient("email", "jane@example.com")
        assertTrue(r is WriteResult.Ok)
        assertEquals("j***@example.com", (r as WriteResult.Ok).value.recipientRedacted)
    }

    @Test
    fun suppressExternalMalformedJsonSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("suppressExternalRecipient" to "not-json{")
        val r = FirestoreClient().suppressExternalRecipient("sms", "+15551234567")
        assertTrue(r is WriteResult.Err)
    }
}
