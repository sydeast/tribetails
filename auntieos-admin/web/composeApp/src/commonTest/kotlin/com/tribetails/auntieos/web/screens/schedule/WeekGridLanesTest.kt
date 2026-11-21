package com.tribetails.auntieos.web.screens.schedule

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #1861: the walk's TUE 10 column. Four visits from 23:05 to 23:46 were drawn on
 * top of one another and the last was cut off at the bottom edge.
 */
class WeekGridLanesTest {
    private val late = WeekGridWindow(22, 24)

    private fun span(id: String, topMinute: Int, height: Int = MIN_BLOCK_MINUTES) = id to BlockSpan(topMinute, height)

    @Test
    fun loneBlockHasTheWholeColumn() {
        assertEquals(GridLane(0, 1), weekGridLanes(listOf(span("a", 0, 60)))["a"])
    }

    @Test
    fun overlappingBlocksSitSideBySide() {
        // 23:05, 23:15, 23:30, 23:46 on a 22:00 window, each drawn 20 minutes tall.
        val lanes = weekGridLanes(listOf(span("d", 106), span("b", 75), span("a", 65), span("c", 90)))
        assertEquals(GridLane(0, 2), lanes["a"])
        assertEquals(GridLane(1, 2), lanes["b"])
        assertEquals(GridLane(0, 2), lanes["c"])
        assertEquals(GridLane(1, 2), lanes["d"])
    }

    @Test
    fun touchingBlocksShareALaneAndGroupsStayApart() {
        val lanes = weekGridLanes(listOf(span("a", 0, 60), span("b", 60, 60), span("c", 120, 30), span("d", 125, 30)))
        assertEquals(GridLane(0, 1), lanes["a"])
        assertEquals(GridLane(0, 1), lanes["b"])
        assertEquals(GridLane(0, 2), lanes["c"])
        assertEquals(GridLane(1, 2), lanes["d"])
    }

    @Test
    fun sameStartOrdersById() {
        assertEquals(weekGridLanes(listOf(span("y", 0), span("x", 0))), weekGridLanes(listOf(span("x", 0), span("y", 0))))
        assertEquals(GridLane(0, 2), weekGridLanes(listOf(span("y", 0), span("x", 0)))["x"])
    }

    @Test
    fun visitWithRoomIsPlacedAtItsStart() {
        assertEquals(BlockSpan(32, 30), visitBlockSpan(22 * 60 + 32, 30, late))
        // A 5-minute visit is drawn at the legible minimum.
        assertEquals(BlockSpan(32, MIN_BLOCK_MINUTES), visitBlockSpan(22 * 60 + 32, 5, late))
    }

    @Test
    fun longVisitNearTheBottomIsDrawnToTheEdge() {
        assertEquals(BlockSpan(90, 30), visitBlockSpan(23 * 60 + 30, 180, late))
    }

    @Test
    fun visitTooNearMidnightIsLiftedToTheMinimum() {
        val s = visitBlockSpan(23 * 60 + 46, 30, late)!!
        assertEquals(MIN_BLOCK_MINUTES, s.heightMinutes)
        assertEquals(120, s.topMinute + s.heightMinutes)
    }

    @Test
    fun startOutsideTheWindowIsNotPlaced() {
        assertNull(visitBlockSpan(21 * 60, 30, late))
        assertNull(visitBlockSpan(24 * 60, 30, late))
    }
}
