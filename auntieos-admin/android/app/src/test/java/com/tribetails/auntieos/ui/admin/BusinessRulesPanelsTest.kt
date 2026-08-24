package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.TimeBlockDefinition
import com.tribetails.auntieos.ui.admin.scheduling.CalendarViewMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ISSUE #519: the rules behind the phone's new Booking rules / Visit records
 * panels, and the two consumers wired in the same change.
 *
 * The panels themselves are Compose and not exercised by this JVM suite, which
 * is exactly why every decision they make lives in a pure function here rather
 * than inside a composable.
 */
class BusinessRulesPanelsTest {

    private val loaded = BusinessSettings(
        businessName = "Tribe Tails",
        timeZone = "America/New_York",
        venmoHandle = "@tribetails",
        calendarSyncId = "cal@group.calendar.google.com",
    )

    // ── the model defaults now describe the shipped behavior ────────────────

    /**
     * `enableAutoReminder24h` shipped as `false` while `kincareReminderCron`
     * sent the reminder for every confirmed booking regardless. The default is
     * the truth now, and the server reads absent as ON to match.
     */
    @Test
    fun `the 24 hour reminder defaults on, matching what the cron already does`() {
        assertTrue(BusinessSettings().enableAutoReminder24h)
    }

    // ── defaultCalendarView: it had no editor AND no consumer ───────────────

    @Test
    fun `a calendar view wire string maps to its mode`() {
        assertEquals(CalendarViewMode.WEEK, CalendarViewMode.fromWire("WEEK"))
        assertEquals(CalendarViewMode.DAY, CalendarViewMode.fromWire(" day "))
    }

    @Test
    fun `an unknown or blank calendar view falls back to the shipped default`() {
        assertEquals(CalendarViewMode.MONTH, CalendarViewMode.fromWire("GANTT"))
        assertEquals(CalendarViewMode.MONTH, CalendarViewMode.fromWire(""))
    }

    // ── whole numbers ───────────────────────────────────────────────────────

    @Test
    fun `a whole number inside the range parses, and the endpoints are inside it`() {
        assertEquals(30, parseWholeNumber("30", 0, 480))
        assertEquals(0, parseWholeNumber("0", 0, 480))
        assertEquals(480, parseWholeNumber("480", 0, 480))
    }

    @Test
    fun `a blank box is not zero, and letters, decimals and out-of-range are refused`() {
        assertNull(parseWholeNumber("  ", 0, 480))
        assertNull(parseWholeNumber("3O", 0, 480))
        assertNull(parseWholeNumber("4.5", 1, 24))
        assertNull(parseWholeNumber("481", 0, 480))
        assertNull(parseWholeNumber("-1", 0, 480))
    }

    // ── option lists ────────────────────────────────────────────────────────

    @Test
    fun `an option list parses, sorts and round-trips`() {
        assertEquals(listOf(5, 10, 15), parseOptionList(" 15,5 , 10 "))
        assertEquals(listOf(5, 10, 15), parseOptionList(formatOptionList(listOf(5, 10, 15))))
    }

    @Test
    fun `an empty, duplicated, zeroed or over-long option list is refused`() {
        assertNull(parseOptionList("   "))
        assertNull(parseOptionList("5, 10, 5"))
        assertNull(parseOptionList("0, 5"))
        assertNull(parseOptionList((1..MAX_OPTION_LIST_LENGTH + 1).joinToString(",")))
    }

    @Test
    fun `a default whose option was deleted moves to the nearest survivor, ties going smaller`() {
        assertEquals(15, clampToOptions(15, listOf(5, 10, 15)))
        assertEquals(10, clampToOptions(15, listOf(5, 10, 20)))
        assertEquals(10, clampToOptions(15, listOf(10, 20)))
        assertEquals(15, clampToOptions(15, emptyList()))
    }

    // ── time blocks ─────────────────────────────────────────────────────────

    private fun row(
        id: String = "midday",
        label: String = "Midday",
        start: String = "11:00",
        end: String = "15:00",
        active: Boolean = true,
    ) = TimeBlockRow(id, label, start, end, active)

    @Test
    fun `a well-formed set of blocks has nothing wrong with it`() {
        assertNull(timeBlockError(listOf(row(), row(id = "evening", label = "Evening", start = "17:00", end = "20:00"))))
    }

    @Test
    fun `a blank name, a duplicate name and a duplicate id are each refused`() {
        assertEquals("Every block needs a name.", timeBlockError(listOf(row(label = "  "))))
        assertNotNull(timeBlockError(listOf(row(), row(id = "b2", label = "MIDDAY"))))
        assertNotNull(timeBlockError(listOf(row(), row(label = "Evening"))))
    }

    @Test
    fun `a block that would wrap past midnight is refused, because resolveTimeBlock would never match it`() {
        assertEquals(
            "\"Midday\" has to end after it starts. A block cannot run past midnight.",
            timeBlockError(listOf(row(start = "22:00", end = "02:00"))),
        )
    }

    @Test
    fun `a malformed or zero-length time is refused`() {
        assertNotNull(timeBlockError(listOf(row(start = "9:00"))))
        assertNotNull(timeBlockError(listOf(row(end = "25:00"))))
        assertNotNull(timeBlockError(listOf(row(start = "11:00", end = "11:00"))))
    }

    @Test
    fun `blocks convert to definitions with the label trimmed and the id untouched`() {
        val defs = listOf(row(label = "  Midday  ")).toDefinitions()
        assertEquals(
            listOf(TimeBlockDefinition(id = "midday", label = "Midday", startTime = "11:00", endTime = "15:00", isActive = true)),
            defs,
        )
    }

    @Test
    fun `a new block id is slugified and never collides`() {
        assertEquals("late-afternoon", slugifyBlockId("Late afternoon", emptyList()))
        assertEquals("block", slugifyBlockId("!!!", emptyList()))
        assertEquals("midday-2", slugifyBlockId("Midday", listOf("midday")))
    }

    @Test
    fun `a new block runs for the default block length, capped at the end of the day`() {
        assertEquals("13:00", defaultBlockEnd("09:00", 4))
        assertEquals("23:59", defaultBlockEnd("22:00", 6))
        assertEquals("23:59", defaultBlockEnd("nope", 4))
    }

    // ── the panel-level rules ───────────────────────────────────────────────

    private fun bookingError(
        mode: String = "SPECIFIC_TIME",
        specific: Boolean = true,
        block: Boolean = true,
        hours: String = "4",
        buffer: String = "30",
        blocks: List<TimeBlockRow> = listOf(row()),
        zone: String = "America/New_York",
    ) = bookingRulesError(mode, specific, block, hours, buffer, blocks, zone)

    @Test
    fun `a sound booking-rules draft has nothing wrong with it`() {
        assertNull(bookingError())
    }

    @Test
    fun `turning both booking modes off is refused`() {
        assertEquals(
            "Leave at least one booking mode on, or nothing can be booked at all.",
            bookingError(specific = false, block = false),
        )
    }

    @Test
    fun `defaulting to a mode that is turned off is refused`() {
        assertNotNull(bookingError(mode = "TIME_BLOCK", block = false))
        assertNotNull(bookingError(mode = "SPECIFIC_TIME", specific = false))
    }

    @Test
    fun `time-block booking with no active block behind it is refused`() {
        assertEquals(
            "Time-block booking is on but no block is active, so there is nothing to book into.",
            bookingError(blocks = listOf(row(active = false))),
        )
    }

    @Test
    fun `a zone this phone cannot resolve is refused, naming it`() {
        assertTrue(bookingError(zone = "Mars/Olympus")!!.contains("Mars/Olympus"))
        assertNull(bookingError(zone = "America/Chicago"))
    }

    @Test
    fun `the zone picker keeps a stored value this phone does not know`() {
        assertTrue(timeZoneOptions("Mars/Olympus").contains("Mars/Olympus"))
        assertTrue(timeZoneOptions("").contains("America/New_York"))
    }

    @Test
    fun `a bad number is named by its field`() {
        assertTrue(bookingError(hours = "0")!!.startsWith("Default block length"))
        assertTrue(bookingError(buffer = "many")!!.startsWith("Travel buffer"))
    }

    @Test
    fun `the visit-records draft names the list that is wrong`() {
        assertNull(visitRecordsError("90", "5, 10", "30, 60"))
        assertTrue(visitRecordsError("0", "5", "30")!!.startsWith("Keep routes for"))
        assertTrue(visitRecordsError("90", "5, 5", "30")!!.startsWith("On-my-way choices"))
        assertTrue(visitRecordsError("90", "5", "30, 30")!!.startsWith("Draft-retention choices"))
    }

    @Test
    fun `an unknown stored vocabulary value stays offered rather than snapping to a legal one`() {
        val out = optionsIncluding(BOOKING_MODE_WIRE, "LEGACY_MODE")
        assertEquals(BOOKING_MODE_WIRE.size + 1, out.size)
        assertEquals("LEGACY_MODE" to "LEGACY_MODE (not a known value)", out.last())
        assertEquals(BOOKING_MODE_WIRE, optionsIncluding(BOOKING_MODE_WIRE, "TIME_BLOCK"))
    }

    // ── diff-vs-rebuild: the trap this codebase is known for ────────────────

    /**
     * Both new panels hand the ViewModel `settings.copy(...)`, never a freshly
     * constructed `BusinessSettings(...)`. This pins that: an edit of one field
     * on the loaded model leaves every field the panel has NO control for
     * exactly where it was, which is what makes the repository-level diff write
     * one key instead of forty-six.
     */
    @Test
    fun `editing one setting off the loaded model leaves the uncontrolled fields alone`() {
        val edited = loaded.copy(travelBufferMinutes = 45)
        val changes = com.tribetails.auntieos.data.model.businessSettingsFieldChanges(loaded, edited)
        assertEquals(mapOf<String, Any?>("travelBufferMinutes" to 45), changes)
        assertEquals(loaded.venmoHandle, edited.venmoHandle)
        assertEquals(loaded.calendarSyncId, edited.calendarSyncId)
    }

    /**
     * The failure mode this repo has hit before: rebuilding the model from form
     * state. The same edit expressed as a fresh construction silently rewrites
     * every field the form has no control for, and the diff dutifully writes
     * them all.
     */
    @Test
    fun `rebuilding from form state instead would have wiped the fields with no control`() {
        val rebuilt = BusinessSettings(travelBufferMinutes = 45)
        val changes = com.tribetails.auntieos.data.model.businessSettingsFieldChanges(loaded, rebuilt)
        assertTrue("a rebuild writes far more than the edited field", changes.size > 1)
        assertEquals("", changes["venmoHandle"])
        assertEquals("", changes["calendarSyncId"])
    }
}
