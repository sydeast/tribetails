package com.kinfolk.portal.config

import kotlin.test.Test
import kotlin.test.assertEquals

/** #1411: one day of the public card's hours, as the About screen prints it. Twin of businessHours.test.ts. */
class BusinessHoursLabelTest {

    @Test
    fun `reads a 24-hour range as a 12-hour one`() {
        assertEquals("9:00 AM to 5:00 PM", hoursLabel("09:00-17:00"))
        assertEquals("7:30 AM to 12:00 PM", hoursLabel("07:30-12:00"))
        assertEquals("12:00 AM to 11:59 PM", hoursLabel("00:00-23:59"))
        assertEquals("10:00 AM to 2:00 PM", hoursLabel(" 10:00 - 14:00 "))
    }

    @Test
    fun `reads a blank day as Closed`() {
        assertEquals(HOURS_CLOSED, hoursLabel(""))
        assertEquals("Closed", hoursLabel("   "))
    }

    @Test
    fun `shows anything it cannot parse as typed, never blank`() {
        assertEquals("By appointment", hoursLabel("By appointment"))
        assertEquals("25:00-26:00", hoursLabel("25:00-26:00"))
        assertEquals("9-5", hoursLabel("9-5"))
    }
}
