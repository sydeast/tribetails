package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Slice 8 integration: FirestoreClient.syncGoogleCalendarBusyEvents routes
 * through platformInvokeCallable, which the jvm actual answers from
 * JvmFirestoreFixtures.callableResponses. Covers happy, decode-failure, and the
 * fail-loud server-error (not-shared) path whose message names the SA verbatim.
 * Same jvm actual backs the desktop surface, so this covers desktop too.
 */
class CalendarSyncClientTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.callableResponses = emptyMap()
    }

    @Test
    fun runSyncReturnsImportedCount() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("syncGoogleCalendarBusyEvents" to """{"imported":2,"scanned":2}""")
        val r = FirestoreClient().syncGoogleCalendarBusyEvents()
        assertTrue(r is WriteResult.Ok)
        assertEquals(2, (r as WriteResult.Ok).value)
    }

    @Test
    fun emptyImportDecodesToZero() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("syncGoogleCalendarBusyEvents" to """{"imported":0,"scanned":0}""")
        val r = FirestoreClient().syncGoogleCalendarBusyEvents()
        assertTrue(r is WriteResult.Ok)
        assertEquals(0, (r as WriteResult.Ok).value)
    }

    @Test
    fun malformedResponseSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("syncGoogleCalendarBusyEvents" to "not-json{")
        val r = FirestoreClient().syncGoogleCalendarBusyEvents()
        assertTrue(r is WriteResult.Err)
    }
}
