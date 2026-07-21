package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Stage 2 Step 4 integration: the new notification quick-action + quote client
 * methods route through platformInvokeCallable, which the jvm actual answers from
 * JvmFirestoreFixtures.callableResponses. Covers happy, decode, and sad paths.
 * Same jvm actual backs desktop, so this is desktop coverage too.
 */
class NotificationQuickActionsClientTest {

    @AfterTest
    fun tearDown() { JvmFirestoreFixtures.callableResponses = emptyMap() }

    @Test
    fun markNotificationReadHappyPathOk() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("markNotificationRead" to """{"ok":true}""")
        assertTrue(FirestoreClient().markNotificationRead("n1") is WriteResult.Ok)
    }

    @Test
    fun markNotificationUnreadHappyPathOk() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("markNotificationUnread" to """{"ok":true}""")
        assertTrue(FirestoreClient().markNotificationUnread("n1") is WriteResult.Ok)
    }

    @Test
    fun archiveNotificationReturnsArchivedCount() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("archiveNotification" to """{"archived":1}""")
        val r = FirestoreClient().archiveNotification("n1")
        assertTrue(r is WriteResult.Ok)
        assertEquals(1, (r as WriteResult.Ok).value)
    }

    @Test
    fun archiveNotificationMissingCountDecodesToZero() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("archiveNotification" to """{"ok":true}""")
        val r = FirestoreClient().archiveNotification("n1")
        assertTrue(r is WriteResult.Ok)
        assertEquals(0, (r as WriteResult.Ok).value)
    }

    @Test
    fun archiveNotificationMalformedJsonSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("archiveNotification" to "not-json{")
        assertTrue(FirestoreClient().archiveNotification("n1") is WriteResult.Err)
    }

    @Test
    fun bulkArchiveNotificationsReturnsArchivedCount() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("bulkArchiveNotifications" to """{"archived":3}""")
        val r = FirestoreClient().bulkArchiveNotifications(listOf("a", "b", "c"))
        assertTrue(r is WriteResult.Ok)
        assertEquals(3, (r as WriteResult.Ok).value)
    }

    @Test
    fun createQuoteReturnsServerMintedId() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("createQuote" to """{"ok":true,"invoiceId":"q_1"}""")
        val r = FirestoreClient().createQuote(
            Invoice(kinfolkId = "kf1", kinfolkName = "Halbrook", invoiceNumber = "Q-1", total = 50.0, amountDue = 50.0),
            sendToKinfolk = true,
        )
        assertTrue(r is WriteResult.Ok)
        assertEquals("q_1", (r as WriteResult.Ok).value)
    }

    @Test
    fun createQuoteMalformedJsonSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createQuote" to "not-json{")
        val r = FirestoreClient().createQuote(
            Invoice(kinfolkId = "kf1", invoiceNumber = "Q-1", total = 50.0, amountDue = 50.0),
            sendToKinfolk = false,
        )
        assertTrue(r is WriteResult.Err)
    }
}
