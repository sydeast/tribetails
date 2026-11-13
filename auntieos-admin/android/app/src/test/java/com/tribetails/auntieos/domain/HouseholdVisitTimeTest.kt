package com.tribetails.auntieos.domain

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.TimeBlockDefinition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * #1863 / #2034: the Android copy of the household-time rule runs the SAME
 * case table as the server and the admin web
 * (mytribe/functions/test/fixtures/householdVisitTime.json), so an Android
 * card and the household's portal cannot disagree about a visit.
 */
class HouseholdVisitTimeTest {

    private val table: JsonObject by lazy {
        // Gradle runs unit tests from the module dir; walk up to the repo root
        // rather than trust a fixed depth.
        var dir: File? = File("").absoluteFile
        var found: File? = null
        while (dir != null && found == null) {
            val candidate = File(dir, "mytribe/functions/test/fixtures/householdVisitTime.json")
            if (candidate.isFile) found = candidate
            dir = dir.parentFile
        }
        JsonParser.parseString(requireNotNull(found) { "shared fixture not found" }.readText()).asJsonObject
    }

    private fun blocksOf(json: com.google.gson.JsonArray) = json.map { e ->
        val o = e.asJsonObject
        TimeBlockDefinition(
            id = o["id"].asString,
            label = o["label"].asString,
            startTime = o["startTime"].asString,
            endTime = o["endTime"].asString,
            isActive = o["active"].asBoolean,
        )
    }

    private fun settingsFor(c: JsonObject): HouseholdTimeSettings {
        val raw = c["settings"]
        val mode = if (raw.isJsonPrimitive) table[raw.asString].asJsonObject else raw.asJsonObject
        val blocks = blocksOf((c["blocks"] ?: table["blocks"]).asJsonArray)
        val startTime = c["serviceStartTimeBooking"]?.asJsonObject?.entrySet()
            ?.associate { it.key to it.value.asBoolean }.orEmpty()
        return HouseholdTimeSettings(
            allowTimeBlockBooking = mode["allowTimeBlockBooking"]?.asBoolean ?: true,
            allowSpecificTimeBooking = mode["allowSpecificTimeBooking"]?.asBoolean ?: true,
            defaultBookingMode = mode["defaultBookingMode"]?.asString ?: "",
            timeBlocks = blocks,
            startTimeServiceIds = startTimeServiceIdsFrom(startTime),
            timeZone = table["timeZone"].asString,
        )
    }

    private fun startMs(localTime: String): Long =
        LocalDate.parse(table["date"].asString).atTime(LocalTime.parse(localTime))
            .atZone(ZoneId.of(table["timeZone"].asString)).toInstant().toEpochMilli()

    @Test
    fun `runs every case of the shared table`() {
        val cases = table["cases"].asJsonArray.map { it.asJsonObject }
        assertTrue("the shared table must be read, not skipped", cases.size >= 20)
        for (c in cases) {
            val name = c["name"].asString
            val settings = settingsFor(c)
            val expect = c["expect"].asJsonObject
            assertEquals(name, expect["mode"].asString, servedHouseholdTimeMode(settings))
            val visit = c["visit"].asJsonObject
            val block = householdBlockFor(
                startMs(visit["localTime"].asString),
                visit["timeBlockId"]?.asString,
                visit["serviceId"]?.asString,
                settings,
            )
            val want = expect["blockId"]
            assertEquals(name, if (want == null || want.isJsonNull) null else want.asString, block?.id)
        }
    }

    @Test
    fun `reads the business clock, never the device`() {
        val s = HouseholdTimeSettings(
            allowTimeBlockBooking = true, allowSpecificTimeBooking = false, defaultBookingMode = TIME_BLOCK_MODE,
            timeBlocks = blocksOf(table["blocks"].asJsonArray), startTimeServiceIds = emptyList(),
            timeZone = "America/Chicago",
        )
        val ms = startMs("12:30")
        assertEquals("midday", householdBlockFor(ms, null, null, s)?.id)
        assertEquals("morning", householdBlockFor(ms, null, null, s, ZoneId.of("America/Los_Angeles"))?.id)
        // A bare stored wall clock is the business's own clock; an ISO instant is an instant.
        assertEquals("midday", householdBlockForStartString("2026-11-17T12:30:00", null, null, s)?.id)
        assertEquals("midday", householdBlockForStartString("2026-11-17T18:30:00Z", null, null, s)?.id)
        assertNull(householdBlockForStartString("", null, null, s))
    }

    @Test
    fun `#2034 an office card names the block the household sees, by the visit's current start`() {
        val blocks = blocksOf(table["blocks"].asJsonArray)
        val settings = BusinessSettings(timeZone = "America/Chicago", timeBlocks = blocks)
            .withHouseholdTimeMode(TIME_BLOCK_MODE).householdTimeSettings()
        // Moved to 12:30: still Midday. Moved to 16:30: Evening, never the old label.
        assertEquals("Midday", householdBlockLabel("2026-11-17T12:30:00", "midday", "Dog Walking", settings))
        assertEquals("Evening", householdBlockLabel("2026-11-17T16:30:00", "midday", "Dog Walking", settings))
        // The tie: 15:30 is 30 minutes from Midday's end and Evening's start.
        assertEquals("Midday", householdBlockLabel("2026-11-17T15:30:00", null, null, settings))
        // Stored as a UTC instant, read on the business clock (12:30 CST).
        assertEquals("Midday", householdBlockLabel("2026-11-17T18:30:00Z", null, null, settings))
        // Exact times: no block name at all.
        val exact = BusinessSettings(timeZone = "America/Chicago", timeBlocks = blocks)
            .withHouseholdTimeMode(EXACT_TIMES_MODE).householdTimeSettings()
        assertNull(householdBlockLabel("2026-11-17T12:30:00", "midday", null, exact))
        // Before the settings read lands: none either.
        assertNull(householdBlockLabel("2026-11-17T12:30:00", "midday", null, null))
        // A start-time KinCare keeps its clock.
        val overnight = settings.copy(startTimeServiceIds = listOf("Overnight"))
        assertNull(householdBlockLabel("2026-11-17T19:00:00", null, "Overnight", overnight))
    }

    @Test
    fun `each mode is written as all three stored fields`() {
        val legacy = BusinessSettings(allowTimeBlockBooking = true, allowSpecificTimeBooking = true, defaultBookingMode = "SPECIFIC_TIME")
        assertEquals(EXACT_TIMES_MODE, storedHouseholdTimeMode(legacy))
        val blocks = legacy.withHouseholdTimeMode(TIME_BLOCK_MODE)
        assertEquals(Triple(TIME_BLOCK_MODE, true, false), Triple(blocks.defaultBookingMode, blocks.allowTimeBlockBooking, blocks.allowSpecificTimeBooking))
        val exact = blocks.withHouseholdTimeMode(EXACT_TIMES_MODE)
        assertEquals(Triple(EXACT_TIMES_MODE, false, true), Triple(exact.defaultBookingMode, exact.allowTimeBlockBooking, exact.allowSpecificTimeBooking))
    }
}
