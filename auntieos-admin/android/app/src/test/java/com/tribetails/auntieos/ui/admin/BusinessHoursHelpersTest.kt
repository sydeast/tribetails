package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessHours
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.DayOfWeek

/**
 * Pure-JVM tests for the weekly hours (#1764): `business_settings.businessHours`,
 * a map of Monday-first day names to "HH:MM-HH:MM" or "" (Closed), read into
 * the editors' rows and the booking wizard's [BusinessHours] rows and back.
 */
class BusinessHoursHelpersTest {

    // ─── parseTimeOrNull (HH:mm 24-hour) ───────────────────────────────────────

    @Test
    fun `parseTimeOrNull accepts valid HHmm`() {
        assertEquals(0 to 0,    parseTimeOrNull("00:00"))
        assertEquals(9 to 0,    parseTimeOrNull("09:00"))
        assertEquals(13 to 30,  parseTimeOrNull("13:30"))
        assertEquals(23 to 59,  parseTimeOrNull("23:59"))
    }

    @Test
    fun `parseTimeOrNull rejects malformed input`() {
        assertNull(parseTimeOrNull(""))
        assertNull(parseTimeOrNull("9:00"))      // missing leading 0
        assertNull(parseTimeOrNull("24:00"))     // hour out of range
        assertNull(parseTimeOrNull("12:60"))     // minute out of range
        assertNull(parseTimeOrNull("ab:cd"))
        assertNull(parseTimeOrNull("12-30"))
    }

    // ─── businessHoursRowProblem (the server's checkBusinessHours rule) ────────

    @Test
    fun `a row whose close is after its open saves, a one-digit hour included`() {
        assertNull(businessHoursRowProblem("09:00", "17:00"))
        assertNull(businessHoursRowProblem("00:00", "23:59"))
        // The server reads "9:00" as 09:00, so the phone does too.
        assertNull(businessHoursRowProblem("9:00", "17:00"))
    }

    @Test
    fun `a close at or before the open says so`() {
        assertEquals(HOURS_CLOSE_BEFORE_OPEN, businessHoursRowProblem("17:00", "17:00"))
        assertEquals(HOURS_CLOSE_BEFORE_OPEN, businessHoursRowProblem("18:00", "09:00"))
    }

    @Test
    fun `a time that is not a time of day is refused`() {
        assertEquals(HOURS_RANGE_INVALID, businessHoursRowProblem("bad", "17:00"))
        assertEquals(HOURS_RANGE_INVALID, businessHoursRowProblem("09:00", "bad"))
        assertEquals(HOURS_RANGE_INVALID, businessHoursRowProblem("24:00", "25:00"))
        assertEquals(HOURS_RANGE_INVALID, businessHoursRowProblem("", "17:00"))
        assertEquals(HOURS_RANGE_INVALID, businessHoursRowProblem("09:00-10:00", "17:00"))
    }

    // ─── formatHoursDisplay ─────────────────────────────────────────────────────

    @Test
    fun `formatHoursDisplay shows the range when open`() {
        val h = BusinessHours(dayOfWeek = 1, isOpen = true, openTime = "09:00", closeTime = "17:00")
        assertEquals("09:00-17:00", formatHoursDisplay(h))
    }

    @Test
    fun `formatHoursDisplay shows Closed when not open`() {
        val h = BusinessHours(dayOfWeek = 6, isOpen = false, openTime = "09:00", closeTime = "17:00")
        assertEquals("Closed", formatHoursDisplay(h))
    }

    // ─── Day names: dayOfWeek 1 = Monday, the java.time convention ─────────────

    @Test
    fun `day names are the server's keys, Monday first, matching java time`() {
        assertEquals(listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"), WEEK_DAY_NAMES)
        DayOfWeek.values().forEach { d ->
            assertEquals(d.name.lowercase(), WEEK_DAY_NAMES[d.value - 1].lowercase())
        }
    }

    // ─── Map to rows ────────────────────────────────────────────────────────────

    @Test
    fun `rows read each stored state, Monday first`() {
        val rows = weeklyHoursRows(
            mapOf("Monday" to "09:00-17:00", "Tuesday" to " 8:30 - 12:00 ", "Saturday" to "", "Sunday" to "  "),
        )
        assertEquals((1..7).toList(), rows.map { it.dayOfWeek })
        assertEquals(WeeklyHoursRow(1, DayHoursKind.OPEN, "09:00", "17:00"), rows[0])
        assertEquals(WeeklyHoursRow(2, DayHoursKind.OPEN, "08:30", "12:00"), rows[1])
        assertEquals(DayHoursKind.NOT_SET, rows[2].kind)
        assertEquals(DayHoursKind.CLOSED, rows[5].kind)
        assertEquals(DayHoursKind.CLOSED, rows[6].kind)
        assertNull(rows[0].problem)
        assertEquals("Not set", rows[2].display)
        assertEquals("Closed", rows[5].display)
        assertEquals("09:00-17:00", rows[0].display)
    }

    @Test
    fun `no map means seven days not set, never invented hours`() {
        val rows = weeklyHoursRows(emptyMap())
        assertEquals(7, rows.size)
        assertTrue(rows.all { it.kind == DayHoursKind.NOT_SET && it.openTime == "" && it.closeTime == "" })
        assertTrue(noWeeklyHoursSet(rows))
        assertFalse(noWeeklyHoursSet(weeklyHoursRows(mapOf("Sunday" to ""))))
    }

    @Test
    fun `keys that are not the server's day names are ignored`() {
        val rows = weeklyHoursRows(mapOf("monday" to "09:00-17:00", "Mon" to "09:00-17:00"))
        assertTrue(noWeeklyHoursSet(rows))
    }

    @Test
    fun `a stored value the parser cannot read keeps its text and says what is wrong`() {
        val rows = weeklyHoursRows(
            mapOf("Monday" to "9am-5pm", "Tuesday" to "17:00-09:00", "Wednesday" to "all day", "Thursday" to "9:00-12:00-13:00"),
        )
        assertEquals(WeeklyHoursRow(1, DayHoursKind.OPEN, "9am", "5pm"), rows[0])
        assertEquals(HOURS_RANGE_INVALID, rows[0].problem)
        assertEquals(HOURS_CLOSE_BEFORE_OPEN, rows[1].problem)
        assertEquals(WeeklyHoursRow(3, DayHoursKind.OPEN, "all day", ""), rows[2])
        assertEquals(HOURS_RANGE_INVALID, rows[2].problem)
        assertEquals(HOURS_RANGE_INVALID, rows[3].problem)
        // Never quietly Closed and never a default range.
        assertTrue(rows.take(4).all { it.kind == DayHoursKind.OPEN && it.wireValue == null })
        assertEquals("9am-5pm", rows[0].display)
    }

    // ─── Rows to the patch ──────────────────────────────────────────────────────

    @Test
    fun `the patch holds only changed days, written with two-digit hours`() {
        val stored = mapOf("Monday" to "09:00-17:00", "Tuesday" to "9:00-17:00", "Saturday" to "")
        val rows = weeklyHoursRows(stored)
            .withRow(WeeklyHoursRow(1, DayHoursKind.OPEN, "8:00", "17:00"))
            .withRow(WeeklyHoursRow(6, DayHoursKind.OPEN, "10:00", "12:00"))
            .withRow(WeeklyHoursRow(7, DayHoursKind.CLOSED))
        assertEquals(
            mapOf("Monday" to "08:00-17:00", "Saturday" to "10:00-12:00", "Sunday" to ""),
            weeklyHoursPatch(stored, rows),
        )
        // Tuesday reads the same as stored, so its "9:00" text is left alone.
        assertEquals("9:00-17:00", withWeeklyHours(stored, rows)["Tuesday"])
    }

    @Test
    fun `an untouched week makes an empty patch`() {
        val stored = mapOf("Monday" to "9:00-17:00", "Saturday" to "", "Sunday" to "9am-5pm")
        assertTrue(weeklyHoursPatch(stored, weeklyHoursRows(stored)).isEmpty())
        assertTrue(weeklyHoursPatch(emptyMap(), weeklyHoursRows(emptyMap())).isEmpty())
    }

    @Test
    fun `a not set row writes no key, and a row with a problem writes nothing`() {
        val rows = weeklyHoursRows(emptyMap())
            .withRow(WeeklyHoursRow(2, DayHoursKind.OPEN, "18:00", "09:00"))
        assertTrue(weeklyHoursPatch(emptyMap(), rows).isEmpty())
    }

    @Test
    fun `fixing an unreadable stored day writes the fixed value`() {
        val stored = mapOf("Monday" to "9am-5pm")
        val rows = weeklyHoursRows(stored).withRow(WeeklyHoursRow(1, DayHoursKind.OPEN, "09:00", "17:00"))
        assertEquals(mapOf("Monday" to "09:00-17:00"), weeklyHoursPatch(stored, rows))
        val closed = weeklyHoursRows(stored).withRow(WeeklyHoursRow(1, DayHoursKind.CLOSED, "9am", "5pm"))
        assertEquals(mapOf("Monday" to ""), weeklyHoursPatch(stored, closed))
    }

    // ─── BusinessHours rows, both ways ──────────────────────────────────────────

    @Test
    fun `businessHoursOf gives a row for each open or closed day only`() {
        val hours = businessHoursOf(
            mapOf("Monday" to "9:00-17:00", "Saturday" to "", "Sunday" to "9am-5pm"),
        )
        assertEquals(listOf(1, 6), hours.map { it.dayOfWeek })
        val mon = hours[0]
        assertTrue(mon.isOpen)
        assertEquals("09:00", mon.openTime)
        assertEquals("17:00", mon.closeTime)
        assertFalse(hours[1].isOpen)
        assertTrue(businessHoursOf(emptyMap()).isEmpty())
    }

    @Test
    fun `businessHoursMapOf writes the map the server reads, and round trips`() {
        val hours = listOf(
            BusinessHours(dayOfWeek = 7, isOpen = false),
            BusinessHours(dayOfWeek = 1, isOpen = true, openTime = "9:00", closeTime = "17:00"),
            BusinessHours(dayOfWeek = 3, isOpen = true, openTime = "18:00", closeTime = "09:00"),
            BusinessHours(dayOfWeek = 8, isOpen = true, openTime = "09:00", closeTime = "17:00"),
        )
        val map = businessHoursMapOf(hours)
        assertEquals(mapOf("Monday" to "09:00-17:00", "Sunday" to ""), map)
        assertEquals(listOf("Monday", "Sunday"), map.keys.toList())
        assertEquals(map, businessHoursMapOf(businessHoursOf(map)))
    }

    // ─── Server refusal beside the row ──────────────────────────────────────────

    @Test
    fun `a refusal naming a day goes beside that day`() {
        assertEquals(
            3 to HOURS_CLOSE_BEFORE_OPEN,
            weeklyHoursRefusal(SettingsRefusal("businessHours", "Wednesday: $HOURS_CLOSE_BEFORE_OPEN")),
        )
        assertNull(weeklyHoursRefusal(SettingsRefusal("businessHours", "The weekly hours did not arrive as a list.")))
        assertNull(weeklyHoursRefusal(SettingsRefusal("serviceRates", "Monday: x")))
        assertNull(weeklyHoursRefusal(null))
    }
}
