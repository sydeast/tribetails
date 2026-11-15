package com.tribetails.auntieos.web.screens.sessions

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

/**
 * #2250: "Undo departed" is offered for a few minutes after Departed. The
 * server stamps when it closes (`undoDepartedUntil`); the console only compares.
 */
@OptIn(ExperimentalTime::class)
class UndoDepartedTest {

    private val until = "2026-11-14T15:35:00.000Z"
    private val untilMs = Instant.parse(until).toEpochMilliseconds()

    @Test
    fun openOnADepartedOrCompletedVisitUntilTheStampedMoment() {
        assertTrue(undoDepartedOpen("COMPLETED", until, untilMs - 240_000))
        assertTrue(undoDepartedOpen(" departed ", until, untilMs))
        assertFalse(undoDepartedOpen("COMPLETED", until, untilMs + 1))
    }

    @Test
    fun closedWithNoStampOrOneThatCannotBeRead() {
        assertFalse(undoDepartedOpen("COMPLETED", "", untilMs))
        assertFalse(undoDepartedOpen("COMPLETED", "soon", untilMs))
        assertNull(undoDepartedUntilMs("2026-11-14 15:35"))
    }

    @Test
    fun closedOnAVisitThatHasNotDeparted() {
        for (status in listOf("SCHEDULED", "ON_MY_WAY", "ARRIVED", "CANCELLED", "")) {
            assertFalse(undoDepartedOpen(status, until, untilMs - 1), status)
        }
    }

    @Test
    fun theConfirmSaysWhereTheVisitGoesAndThatTheHouseholdIsNotTold() {
        assertEquals(
            "Whitfield’s visit will go back to Arrived, with the arrival time it already has. The household is not told.",
            undoDepartedConfirmBody("Whitfield"),
        )
        assertTrue(undoDepartedConfirmBody(" ").startsWith("This visit will go back to Arrived"))
    }

    @Test
    fun aRefusalReadsInTheServersWordsAndABlankOneSaysToCheckTheConnection() {
        assertEquals(
            "Couldn’t undo the departure. Undo departed is only there for 5 minutes after Departed. That time has passed.",
            undoDepartedFailureWords("Undo departed is only there for 5 minutes after Departed. That time has passed."),
        )
        assertEquals("Couldn’t undo the departure. Check your connection and try again.", undoDepartedFailureWords(" "))
    }

    @Test
    fun noSentenceHereCarriesAnEmDash() {
        val all = listOf(
            UNDO_DEPARTED_LABEL, UNDO_DEPARTED_CONFIRM_TITLE, UNDO_DEPARTED_CONFIRM_YES, UNDO_DEPARTED_WAITING,
            UNDO_DEPARTED_NO_ANSWER, undoDepartedConfirmBody("A"), undoDepartedFailureWords(""),
        )
        assertTrue(all.none { it.contains('—') })
    }
}
