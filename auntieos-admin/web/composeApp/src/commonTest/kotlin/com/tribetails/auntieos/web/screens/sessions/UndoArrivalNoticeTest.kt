package com.tribetails.auntieos.web.screens.sessions

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2357: the toast after "Undo arrived" used to say "The arrival notice is off
 * the household's notifications list" after every undo, including one for a
 * household that was never told. It now reads the server's record of what the
 * undo took off and says an entry came off only when one did.
 */
class UndoArrivalNoticeTest {
    private val sentNothing = "Arrival undone. No message was sent about the undo."

    private val cases: List<Triple<UndoneArrivalNotices?, Boolean, String>> = listOf(
        Triple(
            UndoneArrivalNotices(arrived = true, departed = false),
            false,
            "$sentNothing The arrival notice is off the household's notifications list.",
        ),
        Triple(
            UndoneArrivalNotices(arrived = true, departed = true),
            true,
            "$sentNothing The arrival and departure notices are off the household's notifications list.",
        ),
        Triple(
            UndoneArrivalNotices(arrived = false, departed = true),
            true,
            "$sentNothing The household was not told about the arrival. The departure notice is off their notifications list.",
        ),
        Triple(
            UndoneArrivalNotices(arrived = false, departed = false),
            false,
            "$sentNothing The household was not told about the arrival, so nothing was on their notifications list.",
        ),
        Triple(
            UndoneArrivalNotices(arrived = false, departed = false),
            true,
            "$sentNothing The household was not told about the arrival or the departure, so nothing was on their notifications list.",
        ),
        // No record came in time: nothing is claimed about their list.
        Triple(null, false, sentNothing),
        Triple(null, true, sentNothing),
    )

    private fun record(vararg withdrawn: String): JsonObject = buildJsonObject {
        put("event", JsonPrimitive("undo_arrival"))
        put("withdrawn", JsonArray(withdrawn.map { JsonPrimitive(it) }))
    }

    @Test
    fun `each outcome has its own sentence`() {
        for ((off, fromDeparted, sentence) in cases) {
            assertEquals(sentence, undoArrivalDoneSentence(off, fromDeparted))
        }
    }

    @Test
    fun `an entry is said to be off the list only when the server recorded one`() {
        for ((off, fromDeparted, _) in cases) {
            val claims = Regex("\\bis off\\b|\\bare off\\b").containsMatchIn(undoArrivalDoneSentence(off, fromDeparted))
            assertEquals(off != null && (off.arrived || off.departed), claims)
        }
    }

    @Test
    fun `while the record is on its way the toast says it is checking and claims nothing`() {
        assertEquals("$sentNothing Checking the household's notifications list.", UNDO_ARRIVAL_CHECKING)
    }

    @Test
    fun `every line keeps to the house words`() {
        val lines = cases.map { (off, fromDeparted, _) -> undoArrivalDoneSentence(off, fromDeparted) } + UNDO_ARRIVAL_CHECKING
        val banned = Regex("—|inbox|\\bpet\\b|\\bclient\\b|sitter", RegexOption.IGNORE_CASE)
        for (line in lines) assertFalse(banned.containsMatchIn(line), line)
    }

    @Test
    fun `only the patch that takes an arrival back is an undo`() {
        assertTrue(isUndoArrivalPatch(mapOf("status" to "SCHEDULED", "arrivedAt" to "")))
        assertTrue(isUndoArrivalPatch(mapOf("status" to "ON_MY_WAY", "arrivedAt" to "", "arrivalDistanceMeters" to "")))
        assertFalse(isUndoArrivalPatch(mapOf("status" to "ON_MY_WAY", "onMyWayAt" to "2026-11-10T22:00:00Z")))
        assertFalse(isUndoArrivalPatch(mapOf("status" to "ARRIVED", "arrivedAt" to "2026-11-10T22:00:00Z")))
        assertFalse(isUndoArrivalPatch(mapOf("status" to "DEPARTED", "departedAt" to "2026-11-10T22:30:00Z")))
    }

    @Test
    fun `the record's withdrawn list is read as the two notices the console has words for`() {
        assertEquals(UndoneArrivalNotices(arrived = true, departed = false), undoneArrivalNoticesOf(record("arrived")))
        assertEquals(UndoneArrivalNotices(arrived = true, departed = true), undoneArrivalNoticesOf(record("arrived", "departed")))
        assertEquals(UndoneArrivalNotices(arrived = false, departed = true), undoneArrivalNoticesOf(record("departed", "something_new")))
        assertEquals(UndoneArrivalNotices(arrived = false, departed = false), undoneArrivalNoticesOf(record()))
        assertEquals(UndoneArrivalNotices(arrived = false, departed = false), undoneArrivalNoticesOf(buildJsonObject {}))
    }

    @Test
    fun `the record is named by the visit and the stamp of the arrival being undone`() {
        val atMs = 1_794_348_000_000L // 2026-11-10T22:00:00Z
        assertEquals("ses1__undo_arrival__$atMs", undoArrivalRecordId("ses1", "2026-11-10T22:00:00Z"))
        // A stamp an older console wrote, with no zone: read as UTC, as the server reads it.
        assertEquals("ses1__undo_arrival__$atMs", undoArrivalRecordId("ses1", "2026-11-10T22:00:00"))
        assertNull(undoArrivalRecordId("ses1", ""))
        assertNull(undoArrivalRecordId("ses1", null))
        assertNull(undoArrivalRecordId("ses1", "yesterday"))
    }

    @Test
    fun `waits for the record and reads it once it is there`() = runTest {
        var reads = 0
        val asked = mutableListOf<String>()
        val off = awaitUndoneArrivalNotices("ses1", "2026-11-10T22:00:00Z", waitMs = 30_000L) { id ->
            asked += id
            reads += 1
            if (reads < 3) null else record("arrived")
        }
        assertEquals(UndoneArrivalNotices(arrived = true, departed = false), off)
        assertEquals(3, reads)
        assertEquals(setOf("ses1__undo_arrival__1794348000000"), asked.toSet())
    }

    @Test
    fun `a household never told is a record that names nothing, not a missing record`() = runTest {
        val off = awaitUndoneArrivalNotices("ses1", "2026-11-10T22:00:00Z", waitMs = 30_000L) { record() }
        assertEquals(UndoneArrivalNotices(arrived = false, departed = false), off)
    }

    @Test
    fun `no record in time, a read that fails, or no stamp, is null and claims nothing`() = runTest {
        assertNull(awaitUndoneArrivalNotices("ses1", "2026-11-10T22:00:00Z", waitMs = 3_000L) { null })
        assertNull(awaitUndoneArrivalNotices("ses1", "2026-11-10T22:00:00Z", waitMs = 3_000L) { error("offline") })
        var reads = 0
        assertNull(awaitUndoneArrivalNotices("ses1", "", waitMs = 3_000L) { reads += 1; null })
        assertEquals(0, reads)
    }
}
