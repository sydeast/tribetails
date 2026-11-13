package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.DEFAULT_BUSINESS_TIME_ZONE
import com.tribetails.auntieos.data.model.TimeBlockDefinition
import com.tribetails.auntieos.ui.admin.scheduling.CalendarViewMode
import com.tribetails.auntieos.domain.storedHouseholdTimeMode
import com.tribetails.auntieos.domain.withHouseholdTimeMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        timeZone = "America/Chicago",
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


    // ── ISSUE #519 (block manager): overlap and ordering ────────────────────
    @Test
    fun `two ACTIVE blocks that overlap are refused, naming both`() {
        val err = timeBlockError(listOf(
            row(id = "morning", label = "Morning", start = "09:00", end = "13:00"),
            row(id = "midday", label = "Midday", start = "11:00", end = "15:00"),
        ))
        assertNotNull(err)
        assertTrue(err!!.contains("\"Morning\" and \"Midday\" overlap"))
    }
    @Test
    fun `blocks that merely touch are allowed, because the range is half open`() {
        assertNull(timeBlockError(listOf(
            row(id = "morning", label = "Morning", start = "09:00", end = "11:00"),
            row(id = "midday", label = "Midday", start = "11:00", end = "15:00"),
        )))
    }
    /** A parked seasonal block is not a conflict until it is switched on. */
    @Test
    fun `an INACTIVE block may overlap a live one`() {
        assertNull(timeBlockError(listOf(
            row(id = "morning", label = "Morning", start = "09:00", end = "13:00", active = false),
            row(id = "midday", label = "Midday", start = "11:00", end = "15:00"),
        )))
    }
    @Test
    fun `blocks are stored start-ordered whatever order they were typed in`() {
        val defs = listOf(
            row(id = "evening", label = "Evening", start = "17:00", end = "20:00"),
            row(id = "dawn", label = "Dawn", start = "06:00", end = "08:00"),
            row(id = "midday", label = "Midday", start = "11:00", end = "15:00"),
        ).toDefinitions()
        assertEquals(listOf("dawn", "midday", "evening"), defs.map { it.id })
    }
    @Test
    fun `firstActiveOverlap ignores inactive rows and names the live pair`() {
        assertNull(firstActiveOverlap(listOf(
            row(id = "a", label = "A", start = "09:00", end = "12:00", active = false),
            row(id = "b", label = "B", start = "11:00", end = "13:00"),
        )))
        assertEquals(
            "A" to "B",
            firstActiveOverlap(listOf(
                row(id = "a", label = "A", start = "09:00", end = "12:00"),
                row(id = "b", label = "B", start = "11:00", end = "13:00"),
            )),
        )
    }

    // ── the panel-level rules ───────────────────────────────────────────────

    private fun bookingError(
        mode: String = "SPECIFIC_TIME",
        hours: String = "4",
        buffer: String = "30",
        blocks: List<TimeBlockRow> = listOf(row()),
        zone: String = "America/Chicago",
    ) = bookingRulesError(mode, hours, buffer, blocks, zone)
    @Test
    fun `a sound booking-rules draft has nothing wrong with it`() {
        assertNull(bookingError())
        assertNull(bookingError(mode = "TIME_BLOCK"))
    }
    @Test
    fun `#1863 Time Blocks with no active block is refused in the server's words`() {
        assertEquals(
            "Time Blocks needs at least one block turned on. Turn one on, or pick Exact times.",
            bookingError(mode = "TIME_BLOCK", blocks = listOf(row(active = false))),
        )
    }
    @Test
    fun `#1863 Exact times may keep every block off`() {
        assertNull(bookingError(mode = "SPECIFIC_TIME", blocks = listOf(row(active = false))))
    }
    @Test
    fun `#1863 the two modes are the operator's two words`() {
        assertEquals(listOf("Time Blocks", "Exact times"), HOUSEHOLD_TIME_MODE_OPTIONS.map { it.second })
        assertEquals(listOf("TIME_BLOCK", "SPECIFIC_TIME"), HOUSEHOLD_TIME_MODE_OPTIONS.map { it.first })
        assertTrue(HOUSEHOLD_TIME_MODE_OPTIONS.none { it.third.contains('\u2014') })
    }
    @Test
    fun `a zone this phone cannot resolve is refused, naming it`() {
        assertTrue(bookingError(zone = "Mars/Olympus")!!.contains("Mars/Olympus"))
        assertNull(bookingError(zone = "America/Chicago"))
    }

    @Test
    fun `a blank zone is not a draft error, it is flagged on its own banner (#1109)`() {
        assertNull(bookingError(zone = ""))
        assertNull(bookingError(zone = "   "))
    }
    @Test
    fun `the zone picker keeps a stored value this phone does not know`() {
        assertTrue(timeZoneOptions("Mars/Olympus").contains("Mars/Olympus"))
        assertTrue(timeZoneOptions("").contains(DEFAULT_BUSINESS_TIME_ZONE))
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

    /**
     * ISSUE #582. The bounds are the rules guard's own
     * (`bsInt('arrivalRadiusMeters', 10, 5000)`), so the operator reads what is
     * wrong here rather than watching the save bounce off firestore.rules with
     * no usable message.
     */
    @Test
    fun `the visit-records draft refuses an arrival radius the rules would refuse`() {
        assertNull(visitRecordsError("90", "5, 10", "30, 60", "150"))
        assertNull(visitRecordsError("90", "5, 10", "30, 60", "10"))
        assertNull(visitRecordsError("90", "5, 10", "30, 60", "5000"))
        // Tighter than a consumer GPS fix's own error bar: it would refuse everybody.
        assertTrue(
            visitRecordsError("90", "5, 10", "30, 60", "9")!!.startsWith("Arrival must be within"),
        )
        // Wider than 5 km is not a check.
        assertTrue(
            visitRecordsError("90", "5, 10", "30, 60", "5001")!!.startsWith("Arrival must be within"),
        )
        // A cleared box is an unfinished edit, never a silent zero.
        assertTrue(
            visitRecordsError("90", "5, 10", "30, 60", "")!!.startsWith("Arrival must be within"),
        )
    }

    /**
     * #582 diff-vs-rebuild, on the field this change adds. `settings.copy(...)`
     * must write the radius and nothing beside it.
     */
    @Test
    fun `editing only the arrival radius writes only the arrival radius`() {
        val edited = loaded.copy(arrivalRadiusMeters = 300)
        val changes = com.tribetails.auntieos.data.model.businessSettingsFieldChanges(loaded, edited)
        assertEquals(mapOf<String, Any?>("arrivalRadiusMeters" to 300), changes)
    }

    @Test
    fun `an unknown stored vocabulary value stays offered rather than snapping to a legal one`() {
        val out = optionsIncluding(BOOKING_MODE_WIRE, "LEGACY_MODE")
        assertEquals(BOOKING_MODE_WIRE.size + 1, out.size)
        assertEquals("LEGACY_MODE" to "LEGACY_MODE (not a known value)", out.last())
        assertEquals(BOOKING_MODE_WIRE, optionsIncluding(BOOKING_MODE_WIRE, "TIME_BLOCK"))
    }

    // ── #1863: the mode is saved as all three of its fields ─────────────────
    @Test
    fun `#1863 picking a mode writes exactly the three fields that changed, consistently`() {
        val legacy = loaded.copy(allowTimeBlockBooking = true, allowSpecificTimeBooking = true, defaultBookingMode = "SPECIFIC_TIME")
        val changes = com.tribetails.auntieos.data.model.businessSettingsFieldChanges(
            legacy,
            legacy.withHouseholdTimeMode("TIME_BLOCK"),
        )
        // allowTimeBlockBooking was already true; the merged document is consistent.
        assertEquals(mapOf<String, Any?>("defaultBookingMode" to "TIME_BLOCK", "allowSpecificTimeBooking" to false), changes)
    }
    @Test
    fun `#1863 a legacy both-on document reads as the mode bookings opened on, and is not rewritten untouched`() {
        val legacy = loaded.copy(allowTimeBlockBooking = true, allowSpecificTimeBooking = true, defaultBookingMode = "TIME_BLOCK")
        assertEquals("TIME_BLOCK", storedHouseholdTimeMode(legacy))
        assertFalse(bookingEdits(legacy).modes)
        assertTrue(bookingEdits(legacy, mode = "SPECIFIC_TIME").modes)
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

    // ── ISSUE #1612: a new block, and an overlap shown on its rows ──────────

    /** Operator ruling: the app never picks a block's hours. It used to open at 09:00, on top of Midday. */
    @Test
    fun `a new block opens with no start and no end time`() {
        val added = newTimeBlockRow(listOf("midday"))
        assertEquals("", added.startTime)
        assertEquals("", added.endTime)
        assertEquals("", added.label)
        assertTrue(added.active)
        assertTrue(added.id.isNotBlank() && added.id != "midday")
    }

    @Test
    fun `a start typed into a row with no end runs it for the default block length`() {
        val blank = newTimeBlockRow(emptyList())
        assertEquals("19:00", blank.withStartTime("16:00", 3).endTime)
        // Half typed: nothing is filled until the start is a real time.
        assertEquals("", blank.withStartTime("16:0", 3).endTime)
        // An end the operator already gave is never overwritten.
        assertEquals("20:00", blank.copy(endTime = "20:00").withStartTime("16:00", 3).endTime)
    }

    @Test
    fun `an overlap is flagged on both rows while the new one has no name yet`() {
        val rows = listOf(row(), row(id = "block-2", label = "", start = "09:00", end = "13:00"))
        assertEquals(listOf(listOf("a block with no name yet"), listOf("Midday")), blockOverlaps(rows))
        // The banner still stops at the missing name; the rows carry the clash.
        assertEquals("Every block needs a name.", timeBlockError(rows))
    }

    @Test
    fun `a long block is flagged against every block it covers, not only its neighbour`() {
        val rows = listOf(
            row(id = "day", label = "All day", start = "08:00", end = "18:00"),
            row(id = "am", label = "Morning", start = "09:00", end = "10:00"),
            row(id = "pm", label = "Afternoon", start = "14:00", end = "15:00"),
        )
        assertEquals(
            listOf(listOf("Morning", "Afternoon"), listOf("All day"), listOf("All day")),
            blockOverlaps(rows),
        )
    }

    @Test
    fun `touching ends, switched-off rows and rows with no times yet are not overlaps`() {
        val rows = listOf(
            row(),
            row(id = "eve", label = "Evening", start = "15:00", end = "19:00"),
            row(id = "parked", label = "Parked", start = "12:00", end = "13:00", active = false),
            row(id = "blank", label = "", start = "", end = ""),
        )
        assertEquals(listOf(emptyList<String>(), emptyList(), emptyList(), emptyList()), blockOverlaps(rows))
    }

    @Test
    fun `the overlap note names every clashing block`() {
        assertEquals("Overlaps Midday.", overlapNote(listOf("Midday")))
        assertEquals("Overlaps Morning and Midday.", overlapNote(listOf("Morning", "Midday")))
        assertEquals("Overlaps A, B and C.", overlapNote(listOf("A", "B", "C")))
    }

    // ── ISSUE #1612: the copy says one thing about the reminder ─────────────

    @Test
    fun `booking rules and notifications state the same reminder timing`() {
        assertEquals("Remind kinfolk 24 to 48 hours before a visit", VISIT_REMINDER_TOGGLE_TITLE)
        assertTrue(VISIT_REMINDER_NOTE.contains("$VISIT_REMINDER_TIMING each visit"))
        assertFalse(VISIT_REMINDER_TOGGLE_DESCRIPTION.contains("day before"))
    }

    @Test
    fun `the arrival radius note names the switch it depends on`() {
        assertTrue(ARRIVAL_RADIUS_NOTE.startsWith("Only applies while Verify arrival and departure by location is on."))
        assertFalse(ARRIVAL_RADIUS_NOTE.contains("switch above"))
    }

    // ── A stored bad value (#1783) ─────────────────────────────────────────
    private fun bookingEdits(
        settings: BusinessSettings,
        mode: String = storedHouseholdTimeMode(settings),
        hours: String = settings.defaultTimeBlockDurationHours.toString(),
        buffer: String = settings.travelBufferMinutes.toString(),
        blocks: List<TimeBlockRow> = settings.timeBlocks.map { it.toRow() },
        zone: String = settings.timeZone,
    ) = bookingRulesEdits(settings, mode, hours, buffer, blocks, zone)
    private fun bookingHeld(settings: BusinessSettings, buffer: String = settings.travelBufferMinutes.toString(), mode: String = storedHouseholdTimeMode(settings)): String? {
        val edits = bookingEdits(settings, buffer = buffer, mode = mode)
        return bookingRulesError(
            mode,
            settings.defaultTimeBlockDurationHours.toString(), buffer,
            settings.timeBlocks.map { it.toRow() }, settings.timeZone, edits,
        )
    }
    @Test
    fun `a stored bad travel buffer is shown on open but does not hold Save`() {
        val stored = loaded.copy(travelBufferMinutes = 9999)
        // Shown: the full check names it.
        assertEquals(
            "Travel buffer: enter 0 to 480 minutes.",
            bookingRulesError(storedHouseholdTimeMode(stored), "4", "9999", emptyList(), stored.timeZone),
        )
        // Not held: nothing about the buffer is in the save.
        assertNull(bookingHeld(stored))
    }
    @Test
    fun `editing the stored bad buffer to another bad value is held, to a good one is free`() {
        val stored = loaded.copy(travelBufferMinutes = 9999)
        assertEquals("Travel buffer: enter 0 to 480 minutes.", bookingHeld(stored, buffer = "9000"))
        assertNull(bookingHeld(stored, buffer = "45"))
    }
    @Test
    fun `#1863 a stored Time Blocks with no block on does not hold a different edit, and does once the mode is touched`() {
        val stored = loaded.copy(
            allowSpecificTimeBooking = true, allowTimeBlockBooking = true, defaultBookingMode = "SPECIFIC_TIME",
            timeBlocks = listOf(TimeBlockDefinition(id = "midday", label = "Midday", startTime = "11:00", endTime = "15:00", isActive = false)),
        )
        val rows = stored.timeBlocks.map { it.toRow() }
        assertNull(bookingRulesError("SPECIFIC_TIME", "4", "45", rows, stored.timeZone, bookingEdits(stored, buffer = "45")))
        assertEquals(
            "Time Blocks needs at least one block turned on. Turn one on, or pick Exact times.",
            bookingRulesError("TIME_BLOCK", "4", "30", rows, stored.timeZone, bookingEdits(stored, mode = "TIME_BLOCK")),
        )
    }
    @Test
    fun `an unusable stored zone holds Save only once the zone is changed`() {
        val stored = loaded.copy(timeZone = "Mars/Olympus")
        val untouched = bookingEdits(stored)
        assertFalse(untouched.zone)
        assertNull(bookingRulesError(storedHouseholdTimeMode(stored), "4", "30", emptyList(), "Mars/Olympus", untouched))
        val changed = bookingEdits(stored, zone = "Mars/Phobos")
        assertNotNull(bookingRulesError(storedHouseholdTimeMode(stored), "4", "30", emptyList(), "Mars/Phobos", changed))
    }
    private fun visitEdits(settings: BusinessSettings, radius: String = settings.arrivalRadiusMeters.toString()) =
        visitRecordsEdits(
            settings,
            settings.saveRoutesForDays.toString(),
            formatOptionList(settings.etaMinuteOptions),
            formatOptionList(settings.draftRetentionOptions),
            radius,
        )
    @Test
    fun `a stored bad arrival radius is shown, holds nothing, and is held again once edited badly`() {
        val stored = loaded.copy(arrivalRadiusMeters = 3)
        val days = stored.saveRoutesForDays.toString()
        val eta = formatOptionList(stored.etaMinuteOptions)
        val drafts = formatOptionList(stored.draftRetentionOptions)
        assertTrue(visitRecordsError(days, eta, drafts, "3")!!.startsWith("Arrival must be within"))
        assertNull(visitRecordsError(days, eta, drafts, "3", visitEdits(stored)))
        assertTrue(visitRecordsError(days, eta, drafts, "9", visitEdits(stored, "9"))!!.startsWith("Arrival must be within"))
        assertNull(visitRecordsError(days, eta, drafts, "300", visitEdits(stored, "300")))
    }
}
