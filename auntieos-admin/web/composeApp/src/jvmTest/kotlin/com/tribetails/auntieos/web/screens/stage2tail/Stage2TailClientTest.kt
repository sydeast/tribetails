package com.tribetails.auntieos.web.screens.stage2tail

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Stage 2 tail Step 1 integration: the six client methods that route through
 * platformInvokeCallable (answered on jvm by JvmFirestoreFixtures.callableResponses).
 * Covers happy + decode-failure + missing-field paths. The jvm actual is shared
 * with desktop, so this is web (Wasm) + desktop (JVM) coverage in one suite.
 */
class Stage2TailClientTest {

    @AfterTest
    fun tearDown() { JvmFirestoreFixtures.callableResponses = emptyMap() }

    // ---- sendInvoiceReminder ----
    @Test
    fun sendInvoiceReminderReturnsInvoiceId() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("sendInvoiceReminder" to """{"ok":true,"invoiceId":"inv_7"}""")
        val r = FirestoreClient().sendInvoiceReminder("inv_7")
        assertTrue(r is WriteResult.Ok)
        assertEquals("inv_7", (r as WriteResult.Ok).value)
    }

    @Test
    fun sendInvoiceReminderFallsBackToArgIdWhenOmitted() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("sendInvoiceReminder" to """{"ok":true}""")
        val r = FirestoreClient().sendInvoiceReminder("inv_arg")
        assertTrue(r is WriteResult.Ok)
        assertEquals("inv_arg", (r as WriteResult.Ok).value)
    }

    @Test
    fun sendInvoiceReminderMalformedSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("sendInvoiceReminder" to "not-json{")
        val r = FirestoreClient().sendInvoiceReminder("inv_7")
        assertTrue(r is WriteResult.Err)
    }

    // ---- reviewAndSendDraftInvoice (postInvoiceEvent) ----
    @Test
    fun reviewAndSendDraftHappyOk() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("postInvoiceEvent" to """{"ok":true}""")
        val r = FirestoreClient().reviewAndSendDraftInvoice("inv_1", "kf1")
        assertTrue(r is WriteResult.Ok)
    }

    // ---- batchUpdateBookings ----
    @Test
    fun batchUpdateBookingsDecodesCountsAndFailures() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "batchUpdateBookings" to
                """{"ok":true,"action":"APPROVE","updated":2,"failed":[{"id":"x","error":"missing"}]}""",
        )
        val r = FirestoreClient().batchUpdateBookings(listOf("a", "b", "x"), "APPROVE")
        assertTrue(r is WriteResult.Ok)
        val v = (r as WriteResult.Ok).value
        assertEquals("APPROVE", v.action)
        assertEquals(2, v.updated)
        assertEquals(1, v.failedCount)
        assertEquals("x", v.failed.first().id)
        assertEquals("missing", v.failed.first().error)
    }

    @Test
    fun batchUpdateBookingsMalformedSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("batchUpdateBookings" to "not-json{")
        val r = FirestoreClient().batchUpdateBookings(listOf("a"), "CANCEL")
        assertTrue(r is WriteResult.Err)
    }

    // ---- bulkMarkNotificationsRead ----
    @Test
    fun bulkMarkNotificationsReadDecodesMarked() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("bulkMarkNotificationsRead" to """{"ok":true,"marked":3}""")
        val r = FirestoreClient().bulkMarkNotificationsRead(listOf("n1", "n2", "n3"))
        assertTrue(r is WriteResult.Ok)
        assertEquals(3, (r as WriteResult.Ok).value)
    }

    @Test
    fun bulkMarkNotificationsReadMissingMarkedDefaultsZero() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("bulkMarkNotificationsRead" to """{"ok":true}""")
        val r = FirestoreClient().bulkMarkNotificationsRead(listOf("n1"))
        assertTrue(r is WriteResult.Ok)
        assertEquals(0, (r as WriteResult.Ok).value)
    }

    // ---- listCatalogKeys ----
    @Test
    fun listCatalogKeysDecodesSortedKeys() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("listCatalogKeys" to """{"keys":["a.b","c.d"]}""")
        val r = FirestoreClient().listCatalogKeys()
        assertTrue(r is WriteResult.Ok)
        assertEquals(listOf("a.b", "c.d"), (r as WriteResult.Ok).value)
    }

    @Test
    fun listCatalogKeysEmptyDecodesToEmptyList() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("listCatalogKeys" to """{}""")
        val r = FirestoreClient().listCatalogKeys()
        assertTrue(r is WriteResult.Ok)
        assertEquals(emptyList(), (r as WriteResult.Ok).value)
    }
}
