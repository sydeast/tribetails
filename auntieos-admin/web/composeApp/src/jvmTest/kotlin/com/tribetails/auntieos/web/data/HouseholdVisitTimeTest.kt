package com.tribetails.auntieos.web.data

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * #1863 / #2034: the console's copy of the household-time rule runs the SAME
 * case table as the server (mytribe/functions/test/householdVisitTime.test.ts)
 * and the admin web (auntieos-admin/src/lib/householdVisitTime.test.ts).
 */
class HouseholdVisitTimeTest {
    private val table: JsonObject by lazy {
        var dir: File? = File("").absoluteFile
        while (dir != null && !(File(dir, "mytribe").isDirectory && File(dir, "auntieos-admin").isDirectory)) dir = dir.parentFile
        val file = File(dir ?: error("repo root not found"), "mytribe/functions/test/fixtures/householdVisitTime.json")
        assertTrue(file.isFile, "shared case table missing at ${file.absolutePath}")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun blocksOf(raw: kotlinx.serialization.json.JsonArray): List<TimeBlockDefinition> = raw.map { e ->
        val o = e.jsonObject
        TimeBlockDefinition(
            id = o["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            label = o["label"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            startTime = o["startTime"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            endTime = o["endTime"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            isActive = o["active"]?.jsonPrimitive?.booleanOrNull ?: true,
        )
    }

    private fun minutes(localTime: String): Int {
        val (h, m) = localTime.split(":").map { it.toInt() }
        return h * 60 + m
    }

    @Test
    fun runsEveryCaseInTheSharedTable() {
        val cases = table["cases"]!!.jsonArray
        assertTrue(cases.size >= 20, "read ${cases.size} cases; a missing table would pass vacuously")
        for (e in cases) {
            val c = e.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val settingsRef = c["settings"]!!
            val mode: JsonObject =
                if (settingsRef is JsonObject) settingsRef else table[settingsRef.jsonPrimitive.content]!!.jsonObject
            val starts = c["serviceStartTimeBooking"]?.jsonObject
                ?.mapValues { it.value.jsonPrimitive.booleanOrNull == true }.orEmpty()
            val s = HouseholdVisitTime.Settings(
                allowTimeBlockBooking = mode["allowTimeBlockBooking"]?.jsonPrimitive?.booleanOrNull,
                allowSpecificTimeBooking = mode["allowSpecificTimeBooking"]?.jsonPrimitive?.booleanOrNull,
                defaultBookingMode = mode["defaultBookingMode"]?.jsonPrimitive?.contentOrNull,
                timeBlocks = blocksOf((c["blocks"] ?: table["blocks"]!!).jsonArray),
                startTimeServiceIds = HouseholdVisitTime.startTimeServiceIds(starts),
            )
            val expect = c["expect"]!!.jsonObject
            assertEquals(expect["mode"]!!.jsonPrimitive.content, HouseholdVisitTime.servedMode(s), name)
            val visit = c["visit"]!!.jsonObject
            val block = HouseholdVisitTime.householdBlockForMinutes(
                minutes(visit["localTime"]!!.jsonPrimitive.content),
                visit["timeBlockId"]?.jsonPrimitive?.contentOrNull,
                visit["serviceId"]?.jsonPrimitive?.contentOrNull,
                s,
            )
            assertEquals(expect["blockId"]!!.jsonPrimitive.contentOrNull, block?.id, name)
        }
    }

    @Test
    fun readsAnInstantOnTheBusinessClockAndABareWallClockAsWritten() {
        val chicago = TimeZone.of("America/Chicago")
        // 2026-11-17 18:30Z is 12:30 in Chicago (CST).
        assertEquals(12 * 60 + 30, HouseholdVisitTime.businessMinutesOf("2026-11-17T18:30:00Z", chicago))
        assertEquals(12 * 60 + 30, HouseholdVisitTime.businessMinutesOf("2026-11-17T12:30:00", chicago))
        assertNull(HouseholdVisitTime.businessMinutesOf("", chicago))
    }

    private val blocks = listOf(
        TimeBlockDefinition(id = "morning", label = "Morning", startTime = "08:00", endTime = "11:00", isActive = true),
        TimeBlockDefinition(id = "midday", label = "Midday", startTime = "11:00", endTime = "15:00", isActive = true),
        TimeBlockDefinition(id = "evening", label = "Evening", startTime = "16:00", endTime = "19:00", isActive = true),
    )
    private val blocksMode = HouseholdVisitTime.settingsOf(
        BusinessSettings(defaultBookingMode = "TIME_BLOCK", allowTimeBlockBooking = true, allowSpecificTimeBooking = false, timeBlocks = blocks),
    )
    private val exactMode = HouseholdVisitTime.settingsOf(
        BusinessSettings(defaultBookingMode = "SPECIFIC_TIME", allowTimeBlockBooking = false, allowSpecificTimeBooking = true, timeBlocks = blocks),
    )
    private val chicago = TimeZone.of("America/Chicago")

    @Test
    fun cardLabelNamesTheBlockTheHouseholdSeesForAMovedVisit() {
        // #2034: a Midday booking moved to 12:30 stays Midday; moved to 16:30 it is Evening.
        assertEquals("Midday", HouseholdVisitTime.cardBlockLabel("2026-11-17T18:30:00Z", "Walk", blocksMode, chicago))
        assertEquals("Evening", HouseholdVisitTime.cardBlockLabel("2026-11-17T22:30:00Z", "Walk", blocksMode, chicago))
        // The tie: 15:30 is 30 minutes from Midday's end and Evening's start.
        assertEquals("Midday", HouseholdVisitTime.cardBlockLabel("2026-11-17T21:30:00Z", "Walk", blocksMode, chicago))
    }

    @Test
    fun cardLabelNamesNoBlockInExactTimesModeOrForAStartTimeKinCare() {
        assertNull(HouseholdVisitTime.cardBlockLabel("2026-11-17T18:30:00Z", "Walk", exactMode, chicago))
        val overnight = blocksMode.copy(startTimeServiceIds = listOf("Overnight"))
        assertNull(HouseholdVisitTime.cardBlockLabel("2026-11-17T18:30:00Z", "Overnight", overnight, chicago))
        assertNull(HouseholdVisitTime.cardBlockLabel("", "Walk", blocksMode, chicago))
    }

    @Test
    fun eachModeWritesAllThreeFields() {
        assertEquals(
            HouseholdVisitTime.ModeFields("TIME_BLOCK", allowTimeBlockBooking = true, allowSpecificTimeBooking = false),
            HouseholdVisitTime.modeFields("TIME_BLOCK"),
        )
        assertEquals(
            HouseholdVisitTime.ModeFields("SPECIFIC_TIME", allowTimeBlockBooking = false, allowSpecificTimeBooking = true),
            HouseholdVisitTime.modeFields("SPECIFIC_TIME"),
        )
        // An untouched settings document (both switches on, SPECIFIC_TIME) starts on Exact times.
        assertEquals("SPECIFIC_TIME", HouseholdVisitTime.storedMode(BusinessSettings()))
    }
}
