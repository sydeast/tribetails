package com.tribetails.auntieos.web.screens.schedule
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.VisitInternalNote
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlinx.datetime.TimeZone
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
/**
 * #1580: the console reads and writes a visit's internal notes through the two
 * callables, by session, so it shows the same one list as web and Android.
 * Operator ruling 2026-11-05: two kinds, shared and admin-only; the writer marks
 * each note, and Aunties see only shared ones.
 */
class VisitInternalNotesClientTest {
    @AfterTest
    fun tearDown() { JvmFirestoreFixtures.callableResponses = emptyMap() }
    @Test
    fun readsTheListBySessionAndDecodesBothKinds() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listVisitInternalNotes" to """{"notes":[
              {"id":"session:vis_v1","body":"Gate sticks","authorRole":"unknown","authorName":null,"createdAtMs":null,"visibility":"shared","source":"visitRecord"},
              {"id":"a1","body":"Rate goes up","authorRole":"admin","authorName":"Syd","createdAtMs":1700000000000,"visibility":"adminOnly","source":"thread"}
            ],"canMarkAdminOnly":true,"hasBookingRecord":true}""",
        )
        val r = FirestoreClient().listVisitInternalNotes("vis_v1")
        assertTrue(r is WriteResult.Ok)
        val v = (r as WriteResult.Ok).value
        assertEquals(listOf("session:vis_v1", "a1"), v.notes.map { it.id })
        assertEquals("adminOnly", v.notes[1].visibility)
        assertEquals(1_700_000_000_000L, v.notes[1].createdAtMs)
        assertTrue(v.canMarkAdminOnly)
        assertEquals("listVisitInternalNotes", JvmFirestoreFixtures.lastCallableName)
        assertTrue(JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty().contains("\"sessionId\":\"vis_v1\""))
    }
    @Test
    fun sendsTheWritersMark() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "addInternalBookingNote" to """{"noteId":"a1","visibility":"adminOnly","storedOn":"thread"}""",
        )
        val r = FirestoreClient().addVisitInternalNote("vis_v1", "  Rate goes up  ", adminOnly = true)
        assertEquals("adminOnly", (r as WriteResult.Ok).value)
        val payload = JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty()
        assertTrue(payload.contains("\"visibility\":\"adminOnly\""), payload)
        assertTrue(payload.contains("\"body\":\"Rate goes up\""), payload)
        assertTrue(payload.contains("\"sessionId\":\"vis_v1\""), payload)
    }
    @Test
    fun aSharedNoteIsMarkedShared() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "addInternalBookingNote" to """{"noteId":"n1","visibility":"shared","storedOn":"thread"}""",
        )
        FirestoreClient().addVisitInternalNote("vis_v1", "Fed at 5", adminOnly = false)
        assertTrue(JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty().contains("\"visibility\":\"shared\""))
    }
    @Test
    fun bylineMarksAdminOnlyAndNamesTheVisitRecord() {
        val zone = TimeZone.of("America/Chicago")
        val admin = VisitInternalNote("a1", "x", "admin", "Syd", 1_700_000_000_000L, "adminOnly", "thread")
        assertEquals("Admin only · Syd · Nov 14, 4:13 PM", visitNoteByline(admin, zone, 2023))
        val legacy = VisitInternalNote("session:s", "x", "unknown", null, null, "shared", "visitRecord")
        assertEquals("On the visit record", visitNoteByline(legacy, zone))
        val auntie = VisitInternalNote("n1", "x", "auntie", null, null, "shared", "thread")
        assertEquals("Auntie", visitNoteByline(auntie, zone))
    }
}
