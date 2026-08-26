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
 *
 * ISSUE #608: `departedAt` belongs to that same undone arrival, and used to
 * survive it. Undo is offered from DEPARTED as well as ARRIVED, so the sequence
 * arrive → depart → undo left a session whose status says it has not started
 * and whose document still carries the moment it ended. `missingVisitSteps`
 * (`functions/src/lib/arrivalVerification.ts`) reads `arrivedAt` and
 * `departedAt` to decide whether a visit may be COMPLETE, so a later re-arrival
 * could satisfy that gate using a departure the operator had explicitly undone
 * — and every downstream reader of when the Auntie left, invoicing and the
 * household's own record included, inherited the wrong time.
 *
 * The web path (`admin/setVisitLifecycle.ts`) has cleared both since PR #606
 * and documented the divergence while Android lagged. This closes it.
 */
class UndoArrivalPatchTest {

    @Test
    fun `undo rewinds to on-my-way and clears the arrival with all its evidence`() {
        assertEquals(
            mapOf(
                "status" to "ON_MY_WAY",
                "arrivedAt" to "",
                "departedAt" to "",
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
        assertEquals("", patch["departedAt"])
        assertEquals("", patch["arrivalDistanceMeters"])
        assertEquals("", patch["arrivalAccuracyMeters"])
        assertEquals("", patch["arrivalLocationCheckedAt"])
    }

    /**
     * Undo must not stamp a clock onto the document, and must not touch the
     * on-my-way leg it may be rewinding to.
     */
    @Test
    fun `undo writes those six fields and nothing else`() {
        assertEquals(
            setOf(
                "status",
                "arrivedAt",
                "departedAt",
                "arrivalDistanceMeters",
                "arrivalAccuracyMeters",
                "arrivalLocationCheckedAt",
            ),
            undoArrivalPatch("ON_MY_WAY").keys,
        )
    }
    /**
     * The #608 case on its own, named so a failure reads as the defect rather
     * than as a key-set mismatch. Undo is reachable from DEPARTED, so this is
     * the state the old patch left behind.
     */
    @Test
    fun `undoing a departed visit clears the departure too`() {
        assertEquals("", undoArrivalPatch("ON_MY_WAY")["departedAt"])
        assertEquals("", undoArrivalPatch("SCHEDULED")["departedAt"])
    }
    /**
     * `onMyWayAt` is NOT cleared, and that is deliberate rather than the same
     * oversight one field along: it is what chooses the undo target in the first
     * place (`ON_MY_WAY` when set, `SCHEDULED` when not), so clearing it would
     * erase the leg the undo is rewinding TO. `completedAt` is unreachable —
     * undo is only offered from ARRIVED and DEPARTED. `etaMinutesAway` is left
     * alone to match the web path, which also leaves it.
     */
    @Test
    fun `undo does not touch the on-my-way leg it rewinds to`() {
        assertEquals(false, undoArrivalPatch("ON_MY_WAY").containsKey("onMyWayAt"))
        assertEquals(false, undoArrivalPatch("SCHEDULED").containsKey("onMyWayAt"))
        assertEquals(false, undoArrivalPatch("ON_MY_WAY").containsKey("completedAt"))
        assertEquals(false, undoArrivalPatch("ON_MY_WAY").containsKey("etaMinutesAway"))
    }
}
