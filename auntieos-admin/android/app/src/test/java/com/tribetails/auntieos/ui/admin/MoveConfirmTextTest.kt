package com.tribetails.auntieos.ui.admin
import org.junit.Assert.assertEquals
import org.junit.Test
/** #2027: the drag question's first sentence. */
class MoveConfirmTextTest {
    @Test fun namesTheHouseholdAndTheNewTimeOn24HourClock() {
        assertEquals("The Wrens's visit moves to Tue, Nov 17 at 13:30.", moveConfirmText("The Wrens", "2026-11-17T13:30:00"))
    }
    @Test fun anUnreadableTimeSaysANewTime() {
        assertEquals("The Wrens's visit moves to a new time.", moveConfirmText("The Wrens", "soon"))
    }
}
