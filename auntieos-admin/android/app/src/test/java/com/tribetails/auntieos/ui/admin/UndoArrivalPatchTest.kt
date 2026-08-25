package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * ISSUE #582: Undo Arrival must leave NO arrival-location evidence behind.
 *
 * The three fields are the distance measured for the arrival being undone. Left
 * in place, the next arrival — quite possibly at a different door, quite
 * possibly offline and so with no measurement of its own — inherits them, and
 * wrong evidence can refuse a COMPLETE that should pass as easily as pass one
 * that should be refused.
 */
class UndoArrivalPatchTest {

    @Test
    fun `undo rewinds to on-my-way and clears the arrival with all its evidence`() {
        assertEquals(
            mapOf(
                "status" to "ON_MY_WAY",
                "arrivedAt" to "",
                "arrivalDistanceMeters" to "",
                "arrivalAccuracyMeters" to "",
                "arrivalLocationCheckedAt" to "",
            ),
            undoArrivalPatch("ON_MY_WAY"),
        )
    }

    @Test
    fun `undo all the way to scheduled clears exactly the same evidence`() {
        val patch = undoArrivalPatch("SCHEDULED")
        assertEquals("SCHEDULED", patch["status"])
        assertEquals("", patch["arrivalDistanceMeters"])
        assertEquals("", patch["arrivalAccuracyMeters"])
        assertEquals("", patch["arrivalLocationCheckedAt"])
    }

    /**
     * Undo must not stamp a clock onto the document, and must not touch the
     * on-my-way leg it may be rewinding to.
     */
    @Test
    fun `undo writes those five fields and nothing else`() {
        assertEquals(
            setOf(
                "status",
                "arrivedAt",
                "arrivalDistanceMeters",
                "arrivalAccuracyMeters",
                "arrivalLocationCheckedAt",
            ),
            undoArrivalPatch("ON_MY_WAY").keys,
        )
    }
}
