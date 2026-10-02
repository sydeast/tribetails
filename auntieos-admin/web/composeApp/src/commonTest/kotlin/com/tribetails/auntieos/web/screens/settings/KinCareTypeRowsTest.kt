package com.tribetails.auntieos.web.screens.settings
import com.tribetails.auntieos.web.data.BusinessSettings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
/**
 * Issue #1095: the desktop console's KinCare types panel edits a length and a
 * "You set the start time" flag per row, folded by the same rules as admin web
 * (`KinCareRatesEditor.tsx`) and Android (`KinCareTypesEditor.kt`).
 */
class KinCareTypeRowsTest {
    private fun row(type: String, duration: String = "", rate: String = "", startTime: Boolean = false) =
        KinCareTypeRow(type, duration, rate, startTime)
    @Test fun `rows seed from the three stored maps`() {
        val rows = kinCareRows(
            rates = mapOf("Overnight" to "90", "30Minute" to "25"),
            durations = mapOf("Overnight" to "720"),
            startTimes = mapOf("Overnight" to true),
        )
        assertEquals(row("Overnight", "720", "90", true), rows[0])
        assertEquals(row("30Minute", "", "25", false), rows[1])
    }
    @Test fun `a blank length writes no key`() {
        val rows = listOf(row("Overnight", "720", "90"), row("30Minute", "  ", "25"))
        assertEquals(mapOf("Overnight" to "720"), foldKinCareDurations(rows))
    }
    @Test fun `only flagged rows write the start time map and the value is true`() {
        val rows = listOf(row("Overnight", "720", "90", true), row("30Minute", "", "25", false))
        assertEquals(mapOf("Overnight" to true), foldKinCareStartTime(rows))
    }
    @Test fun `a renamed type carries its flag and length and drops the old key`() {
        val settings = BusinessSettings(
            serviceRates = mapOf("Overnight" to "90"),
            serviceDurations = mapOf("Overnight" to "720"),
            serviceStartTimeBooking = mapOf("Overnight" to true),
        )
        val renamed = kinCareRows(settings.serviceRates, settings.serviceDurations, settings.serviceStartTimeBooking)
            .map { it.copy(type = "Overnight Stay") }
        val applied = kinCareRowsApplied(settings, renamed)
        assertEquals(mapOf("Overnight Stay" to "720"), applied.serviceDurations)
        assertEquals(mapOf("Overnight Stay" to true), applied.serviceStartTimeBooking)
    }
    @Test fun `clearing the flag removes the key`() {
        val settings = BusinessSettings(
            serviceRates = mapOf("Overnight" to "90"),
            serviceStartTimeBooking = mapOf("Overnight" to true),
        )
        val cleared = kinCareRows(settings.serviceRates, settings.serviceDurations, settings.serviceStartTimeBooking)
            .map { it.copy(startTime = false) }
        assertTrue(kinCareRowsDirty(settings, cleared))
        assertEquals(emptyMap(), kinCareRowsApplied(settings, cleared).serviceStartTimeBooking)
    }
    @Test fun `an unflagged duplicate after a flagged one removes the key`() {
        val rows = listOf(row("Overnight", "720", "90", true), row("Overnight", "720", "90", false))
        assertEquals(emptyMap(), foldKinCareStartTime(rows))
    }
    @Test fun `untouched rows are not dirty and a stored false flag counts as absent`() {
        val settings = BusinessSettings(
            serviceRates = mapOf("Walk" to "25"),
            serviceStartTimeBooking = mapOf("Walk" to false),
        )
        val rows = kinCareRows(settings.serviceRates, settings.serviceDurations, settings.serviceStartTimeBooking)
        assertFalse(kinCareRowsDirty(settings, rows))
    }
    @Test fun `typing a length makes the panel dirty`() {
        val settings = BusinessSettings(serviceRates = mapOf("Walk" to "25"))
        val rows = kinCareRows(settings.serviceRates, settings.serviceDurations, settings.serviceStartTimeBooking)
        assertTrue(kinCareRowsDirty(settings, listOf(rows[0].copy(duration = "45"))))
    }
    @Test fun `applying rows leaves every other setting alone`() {
        val settings = BusinessSettings(businessName = "TribeTails", serviceRates = mapOf("Walk" to "25"))
        val applied = kinCareRowsApplied(settings, listOf(row("Walk", "45", "25")))
        assertEquals("TribeTails", applied.businessName)
        assertEquals(mapOf("Walk" to "45"), applied.serviceDurations)
    }
    // ---- the refusal ----
    @Test fun `a flagged row with no length anywhere is refused by name`() {
        val rows = listOf(row("Overnight", "", "90", true))
        assertEquals("Overnight", kinCareStartTimeMissingLength(rows))
        assertEquals(
            "\"Overnight\" needs a length so its end time can be worked out.",
            kinCareNeedsLengthMessage("Overnight"),
        )
    }
    @Test fun `a typed length or a length in the name satisfies the flag`() {
        assertNull(kinCareStartTimeMissingLength(listOf(row("Overnight", "720", "90", true))))
        assertNull(kinCareStartTimeMissingLength(listOf(row("12Hrs", "", "90", true))))
        assertNull(kinCareStartTimeMissingLength(listOf(row("45Minute", "", "25", true))))
    }
    @Test fun `junk or zero typed length does not satisfy the flag`() {
        assertEquals("Overnight", kinCareStartTimeMissingLength(listOf(row("Overnight", "abc", "90", true))))
        assertEquals("Overnight", kinCareStartTimeMissingLength(listOf(row("Overnight", "0", "90", true))))
    }
    @Test fun `an unflagged row is never refused`() {
        assertNull(kinCareStartTimeMissingLength(listOf(row("Overnight", "", "90", false))))
    }
    @Test fun `the name parse takes the largest match`() {
        assertEquals(360, kinCareNameMinutes("Half-Day 6Hrs"))
        assertEquals(60, kinCareNameMinutes("1Hr"))
        assertNull(kinCareNameMinutes("Consultation"))
    }
    @Test fun `the placeholder shows the length the name implies and nothing once typed`() {
        assertEquals("45 (from the name)", kinCareDurationPlaceholder(row("45Minute")))
        assertEquals("Not set", kinCareDurationPlaceholder(row("Overnight")))
        assertEquals("", kinCareDurationPlaceholder(row("45Minute", "50")))
    }
    @Test fun `the switch copy is the 1098 wording`() {
        assertEquals("You set the start time", KIN_CARE_START_TIME_LABEL)
        assertEquals(
            "Kinfolk ask for the night. You set the start time when you approve the request. Use it for overnights.",
            KIN_CARE_START_TIME_TIP,
        )
    }
}
