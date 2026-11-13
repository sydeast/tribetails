package com.tribetails.auntieos.web.screens.schedule

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
import kotlin.test.assertTrue

/**
 * #2030 on the desktop console: the notes an operator writes the household
 * reach the callables that store them where the portal reads them.
 *
 * - A kinfolk-facing note goes to `addBookingNote`. It used to be refused on
 *   desktop ("not wired"), so it never reached anyone.
 * - The note on Accept or Decline of a request rides `manageBookingSeries`.
 */
class HouseholdNotesClientTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    private fun lastPayload() = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject

    @Test
    fun kinfolkFacingNoteGoesToAddBookingNote() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("addBookingNote" to """{"noteId":"n1"}""")
        val r = FirestoreClient().addBookingNote("fam1", "v1", "  Treats are on the shelf.  ", internal = false)
        assertEquals(WriteResult.Ok("n1"), r)
        assertEquals("addBookingNote", JvmFirestoreFixtures.lastCallableName)
        val p = lastPayload()
        assertEquals("fam1", p["kinfolkId"]?.jsonPrimitive?.content)
        assertEquals("v1", p["bookingId"]?.jsonPrimitive?.content)
        assertEquals("Treats are on the shelf.", p["body"]?.jsonPrimitive?.content)
    }

    @Test
    fun aRefusedNoteSaysSo() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("addBookingNote" to "Notes close 3 hours before the visit.")
        val r = FirestoreClient().addBookingNote("fam1", "v1", "late", internal = false)
        assertTrue(r is WriteResult.Err)
        assertEquals("Notes close 3 hours before the visit.", (r as WriteResult.Err).message)
    }

    @Test
    fun approveCarriesTheHouseholdNote() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "manageBookingSeries" to """{"ok":true,"action":"APPROVE","batchId":"b1","affectedVisits":2,"sessionsCreated":2,"failedVisits":0,"householdNotified":true,"newlyConfirmed":2}""",
        )
        val r = FirestoreClient().manageBookingSeries("APPROVE", "fam1", "b1", "  Booked. Bring the spare key.  ")
        assertTrue(r is WriteResult.Ok)
        assertEquals("manageBookingSeries", JvmFirestoreFixtures.lastCallableName)
        assertEquals("Booked. Bring the spare key.", lastPayload()["note"]?.jsonPrimitive?.content)
    }

    @Test
    fun aBlankNoteIsNotSent() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "manageBookingSeries" to """{"ok":true,"action":"CANCEL","batchId":"b1","affectedVisits":1,"sessionsCreated":0,"failedVisits":0,"householdNotified":true,"newlyConfirmed":0}""",
        )
        FirestoreClient().manageBookingSeries("CANCEL", "fam1", "b1", "   ")
        assertFalse(lastPayload().containsKey("note"))
    }
}
