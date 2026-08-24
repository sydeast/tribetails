package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.BUSINESS_SETTINGS_SERVER_OWNED
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.TimeBlockDefinition
import com.tribetails.auntieos.web.data.businessSettingsChangedFields
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * ISSUE #519: the rules behind the desktop console's new Booking rules, Visits
 * and tracking, and Time zone panels — plus the diff write those panels now save
 * through.
 *
 * The panels are Compose and not exercised here, which is exactly why every
 * decision they make lives in a pure function rather than inside a composable.
 */
class BusinessRulesPanelsTest {

    private val codec = Json { encodeDefaults = true; ignoreUnknownKeys = true; isLenient = true }

    private val loaded = BusinessSettings(
        _id = "business_settings",
        businessName = "Tribe Tails",
        timeZone = "America/New_York",
        venmoHandle = "@tribetails",
        calendarSyncId = "cal@group.calendar.google.com",
        updatedAt = "2026-01-01T00:00:00Z",
        updatedBy = "auntie",
    )

    // ── the model now describes the shipped behavior ────────────────────────

    @Test
    fun `the 24 hour reminder defaults on, matching what the cron already does`() {
        assertTrue(BusinessSettings().enableAutoReminder24h)
    }

    // ── the desktop write is a diff, not the whole model ────────────────────

    @Test
    fun `an unchanged document diffs to nothing, so no save moves the stamp`() {
        assertEquals(emptyMap(), businessSettingsChangedFields(loaded, loaded.copy(), codec))
    }

    @Test
    fun `only the changed field appears`() {
        val changes = businessSettingsChangedFields(loaded, loaded.copy(travelBufferMinutes = 45), codec)
        assertEquals(setOf("travelBufferMinutes"), changes.keys)
        assertEquals(JsonPrimitive(45), changes["travelBufferMinutes"])
    }

    /** Clearing a value is an edit, not a no-op: the blank must be written. */
    @Test
    fun `a field cleared to blank is written as blank`() {
        val changes = businessSettingsChangedFields(loaded, loaded.copy(venmoHandle = ""), codec)
        assertEquals(mapOf("venmoHandle" to JsonPrimitive("")), changes)
    }

    /**
     * The whole point. A panel saving one toggle must not write back the sibling
     * fields it merely read, which is what the old whole-object merge did.
     */
    @Test
    fun `a panel save never names a field another surface may have changed since the read`() {
        val changes = businessSettingsChangedFields(loaded, loaded.copy(enableAutoReminder24h = false), codec)
        assertFalse(changes.containsKey("calendarSyncId"))
        assertFalse(changes.containsKey("venmoHandle"))
        assertFalse(changes.containsKey("businessName"))
    }

    @Test
    fun `the doc id and the two stamps are never round-tripped`() {
        val changes = businessSettingsChangedFields(
            loaded,
            loaded.copy(_id = "other", updatedAt = "2026-09-09T00:00:00Z", updatedBy = "someone-else"),
            codec,
        )
        assertEquals(emptyMap(), changes)
        assertEquals(setOf("_id", "updatedAt", "updatedBy"), BUSINESS_SETTINGS_SERVER_OWNED)
    }

    /**
     * The failure mode this repo has hit before: rebuilding the model from form
     * state instead of copying the loaded one. Under a diff write it is worse
     * than under a merge — every field is named as changed and the Kotlin
     * defaults go over the operator's document.
     */
    @Test
    fun `rebuilding from form state instead would have written the defaults over everything`() {
        val rebuilt = BusinessSettings(travelBufferMinutes = 45)
        val changes = businessSettingsChangedFields(loaded, rebuilt, codec)
        assertTrue(changes.size > 1, "a rebuild names far more than the edited field")
        assertEquals(JsonPrimitive(""), changes["businessName"])
        assertEquals(JsonPrimitive(""), changes["calendarSyncId"])
    }

    // ── whole numbers and option lists ──────────────────────────────────────

    @Test
    fun `whole numbers parse inside their range and refuse everything else`() {
        assertEquals(30, parseWholeNumber("30", 0, 480))
        assertEquals(0, parseWholeNumber("0", 0, 480))
        assertNull(parseWholeNumber("  ", 0, 480))
        assertNull(parseWholeNumber("3O", 0, 480))
        assertNull(parseWholeNumber("4.5", 1, 24))
        assertNull(parseWholeNumber("481", 0, 480))
    }

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
    fun `blocks convert to definitions with the label trimmed and the id untouched`() {
        assertEquals(
            listOf(TimeBlockDefinition(id = "midday", label = "Midday", startTime = "11:00", endTime = "15:00", isActive = true)),
            listOf(row(label = "  Midday  ")).toDefinitions(),
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

    // ── panel-level rules ───────────────────────────────────────────────────

    private fun bookingError(
        mode: String = "SPECIFIC_TIME",
        specific: Boolean = true,
        block: Boolean = true,
        hours: String = "4",
        buffer: String = "30",
        blocks: List<TimeBlockRow> = listOf(row()),
        zoneUsable: Boolean = true,
    ) = bookingRulesError(mode, specific, block, hours, buffer, blocks, "America/New_York", zoneUsable)

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

    // ── time zone ───────────────────────────────────────────────────────────

    @Test
    fun `the zone picker keeps a stored value this runtime does not know, and always the default`() {
        assertTrue(timeZoneOptions("Mars/Olympus").contains("Mars/Olympus"))
        assertTrue(timeZoneOptions("").contains("America/New_York"))
        assertTrue(timeZoneOptions("").contains("America/Chicago"))
    }

    @Test
    fun `an unusable zone is caught before it is saved`() {
        assertTrue(platformTimeZoneUsable("America/Chicago"))
        assertFalse(platformTimeZoneUsable("Mars/Olympus"))
        assertFalse(platformTimeZoneUsable("   "))
    }
}
