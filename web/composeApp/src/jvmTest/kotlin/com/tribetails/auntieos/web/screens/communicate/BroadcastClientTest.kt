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
 * Stage 2 step 6 integration: FirestoreClient broadcast + audience-segment
 * methods route through platformInvokeCallable, answered on jvm (= desktop too)
 * by JvmFirestoreFixtures.callableResponses. Covers happy, decode-blank, and
 * malformed-json fail-loud paths.
 */
class BroadcastClientTest {

    @AfterTest
    fun tearDown() { JvmFirestoreFixtures.callableResponses = emptyMap() }

    @Test
    fun listSegmentsHappyPath() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listAudienceSegments" to """{"ok":true,"segments":[{"id":"s1","name":"VIPs","description":"d","updatedAtMs":1,"criteria":{"kind":"all"}}]}""",
        )
        val r = FirestoreClient().listAudienceSegments()
        assertTrue(r is WriteResult.Ok)
        assertEquals("VIPs", (r as WriteResult.Ok).value.single().name)
    }

    @Test
    fun saveSegmentReturnsId() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("saveAudienceSegment" to """{"ok":true,"id":"seg9"}""")
        val r = FirestoreClient().saveAudienceSegment(null, "New", BroadcastCriteria(SegmentKind.All))
        assertTrue(r is WriteResult.Ok)
        assertEquals("seg9", (r as WriteResult.Ok).value)
    }

    @Test
    fun deleteSegmentOk() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("deleteAudienceSegment" to """{"ok":true,"id":"seg9"}""")
        val r = FirestoreClient().deleteAudienceSegment("seg9")
        assertTrue(r is WriteResult.Ok)
    }

    @Test
    fun broadcastHappyPathDecodesCounts() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "broadcastMessage" to """{"ok":true,"broadcastId":"b1","recipientCount":2,"perChannel":{"sms":{"sent":2,"skipped":0,"failed":0}}}""",
        )
        val r = FirestoreClient().broadcastMessage(
            segmentId = null,
            criteria = BroadcastCriteria(SegmentKind.All),
            channels = listOf(BroadcastChannel.Sms),
            subject = null,
            body = "Hi",
        )
        assertTrue(r is WriteResult.Ok)
        val v = (r as WriteResult.Ok).value
        assertEquals(2, v.recipientCount)
        assertEquals(ChannelCounts(2, 0, 0), v.perChannel["sms"])
    }

    @Test
    fun broadcastMalformedJsonSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("broadcastMessage" to "not-json{")
        val r = FirestoreClient().broadcastMessage(null, BroadcastCriteria(SegmentKind.All), listOf(BroadcastChannel.Sms), null, "Hi")
        assertTrue(r is WriteResult.Err)
    }
}
