package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * #2357: the toast after "Undo Arrival" used to say "The arrival notice is off
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
        for (line in lines) assertEquals(line, false, banned.containsMatchIn(line))
    }

    @Test
    fun `the record's withdrawn list is read as the two notices this app has words for`() {
        assertEquals(UndoneArrivalNotices(arrived = true, departed = false), undoneArrivalNoticesOf(listOf("arrived")))
        assertEquals(UndoneArrivalNotices(arrived = true, departed = true), undoneArrivalNoticesOf(listOf("arrived", "departed")))
        assertEquals(UndoneArrivalNotices(arrived = false, departed = true), undoneArrivalNoticesOf(listOf("departed", "something_new")))
        assertEquals(UndoneArrivalNotices(arrived = false, departed = false), undoneArrivalNoticesOf(emptyList<String>()))
        assertEquals(UndoneArrivalNotices(arrived = false, departed = false), undoneArrivalNoticesOf(null))
    }

    @Test
    fun `the record is named by the visit and the stamp of the arrival being undone`() {
        val atMs = java.time.Instant.parse("2026-11-10T22:00:00Z").toEpochMilli()
        assertEquals("ses1__undo_arrival__$atMs", undoArrivalRecordId("ses1", "2026-11-10T22:00:00.000Z"))
        assertEquals("ses1__undo_arrival__$atMs", undoArrivalRecordId("ses1", "2026-11-10T16:00:00-06:00"))
        assertNull(undoArrivalRecordId("ses1", ""))
        assertNull(undoArrivalRecordId("ses1", null))
        assertNull(undoArrivalRecordId("ses1", "yesterday"))
    }

    @Test
    fun `a stamp with no zone, as the desktop console writes it, is read as the server reads it`() {
        // `functions/src/lib/visitStepNotice.ts#stampMs` reads it as UTC, whatever zone this phone is in.
        val asUtc = java.time.Instant.parse("2026-11-10T16:00:00Z").toEpochMilli()
        assertEquals(asUtc, visitStampMillisOrNull("2026-11-10T16:00:00"))
        assertEquals(asUtc, visitStampMillisOrNull("2026-11-10T16:00"))
        assertEquals(asUtc + 250, visitStampMillisOrNull("2026-11-10T16:00:00.250"))
    }
}
