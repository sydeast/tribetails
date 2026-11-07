package com.tribetails.auntieos.web.screens.schedule

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/**
 * #1606: the week grid reaches every visit. It stopped at 8a to 6p and hid a
 * 6:30 visit behind a footer line; it now grows in whole hours.
 */
class WeekGridWindowTest {
    @Test
    fun aWeekInsideTheDefaultHoursKeepsThem() {
        assertEquals(WeekGridWindow(8, 18), weekGridWindow(emptyList()))
        assertEquals(WeekGridWindow(8, 18), weekGridWindow(listOf(9 * 60 to 10 * 60)))
    }

    @Test
    fun anEarlyOrLateVisitWidensTheWeekInWholeHours() {
        assertEquals(WeekGridWindow(6, 18), weekGridWindow(listOf(6 * 60 + 30 to 7 * 60)))
        assertEquals(WeekGridWindow(8, 19), weekGridWindow(listOf(18 * 60 + 30 to 19 * 60)))
        assertEquals(WeekGridWindow(8, 21), weekGridWindow(listOf(20 * 60 to 20 * 60 + 1)))
    }

    @Test
    fun neverPastMidnightAndAnUnreadableEndStillGetsARow() {
        assertEquals(WeekGridWindow(8, 24), weekGridWindow(listOf(23 * 60 + 50 to 25 * 60)))
        assertEquals(WeekGridWindow(8, 20), weekGridWindow(listOf(19 * 60 to null)))
    }

    @Test
    fun aBusyBlockOutsideTheDefaultPlacesInAWiderWeek() {
        val p = assertNotNull(busyPlacement("18:00", "19:00", WeekGridWindow(8, 19)))
        assertEquals(10 * 60, p.topMinutes)
        assertEquals(60, p.heightMinutes)
    }
}
