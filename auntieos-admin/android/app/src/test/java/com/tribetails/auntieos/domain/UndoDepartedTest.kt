package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * #2250: "Undo departed" is offered for a few minutes after Departed. The
 * server stamps when it closes (`undoDepartedUntil`); the phone only compares.
 */
class UndoDepartedTest {

    private val until = "2026-11-14T15:35:00.000Z"
    private val untilMs = Instant.parse(until).toEpochMilli()

    @Test
    fun `open on a Departed or Completed visit until the stamped moment`() {
        assertTrue(undoDepartedOpen("COMPLETED", until, untilMs - 240_000))
        assertTrue(undoDepartedOpen(" departed ", until, untilMs))
        assertFalse(undoDepartedOpen("COMPLETED", until, untilMs + 1))
    }

    @Test
    fun `closed with no stamp or one that cannot be read`() {
        assertFalse(undoDepartedOpen("COMPLETED", null, untilMs))
        assertFalse(undoDepartedOpen("COMPLETED", "  ", untilMs))
        assertFalse(undoDepartedOpen("COMPLETED", "soon", untilMs))
        assertNull(undoDepartedUntilMs("2026-11-14 15:35"))
    }

    @Test
    fun `closed on a visit that has not departed`() {
        for (status in listOf("SCHEDULED", "ON_MY_WAY", "ARRIVED", "CANCELLED", "", null)) {
            assertFalse(undoDepartedOpen(status, until, untilMs - 1))
        }
    }

    @Test
    fun `the confirm says where the visit goes and that the household is not told`() {
        assertEquals(
            "The Rivera Home’s visit will go back to Arrived, with the arrival time it already has. The household is not told.",
            undoDepartedConfirmBody("The Rivera Home"),
        )
        assertTrue(undoDepartedConfirmBody("  ").startsWith("This visit will go back to Arrived"))
    }

    @Test
    fun `a refusal reads in the server's words, and no answer says to check the connection`() {
        assertEquals(
            "Couldn’t undo the departure. Undo departed is only there for 5 minutes after Departed. That time has passed.",
            undoDepartedFailureWords("Undo departed is only there for 5 minutes after Departed. That time has passed."),
        )
        assertEquals("Couldn’t undo the departure. Check your connection and try again.", undoDepartedFailureWords(null))
        assertEquals("Couldn’t undo the departure. Check your connection and try again.", undoDepartedFailureWords(" "))
    }

    @Test
    fun `no sentence here carries an em dash`() {
        val all = listOf(
            UNDO_DEPARTED_LABEL, UNDO_DEPARTED_CONFIRM_TITLE, UNDO_DEPARTED_CONFIRM_YES, UNDO_DEPARTED_WAITING,
            UNDO_DEPARTED_NO_ANSWER, undoDepartedConfirmBody("A"), undoDepartedFailureWords(null),
        )
        assertTrue(all.none { it.contains('—') })
    }
}
