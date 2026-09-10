package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-logic tests for the Coverage Package Builder domain (PackageBuilder_7
 * model), mirroring the web `coveragePackage.test.ts` so both platforms are
 * pinned to the same behaviour.
 */
class CoveragePackageTest {

    private val overnight = DEFAULT_DURATIONS.first { it.kind == "overnight" } // d7, $150, 720min

    private fun pkg(
        visits: List<Visit> = emptyList(),
        overnightNights: Map<Int, Boolean> = emptyMap(),
        overnightStart: String = "21:00",
        overnightBufferHours: Double = 2.0,
        discountPct: Double = 0.0,
        discountLabel: String = "",
    ) = Package("p1", "Test", visits, emptyMap(), overnightNights, overnightStart, overnightBufferHours, discountLabel, discountPct)

    @Test
    fun `daysBetween counts inclusively`() {
        assertEquals(5, daysBetween("2026-07-01", "2026-07-05"))
        assertEquals(0, daysBetween("2026-07-05", "2026-07-01"))
    }

    @Test
    fun `withKind migrates the legacy overnight id, defaults the rest to visit`() {
        val migrated = withKind(listOf(Duration("x", "A", 30.0, 20.0, ""), Duration("d7", "Overnight", 720.0, 150.0, "")))
        assertEquals("visit", migrated[0].kind)
        assertEquals("overnight", migrated[1].kind)
    }

    @Test
    fun `durationsFromServiceRates reads the KinCare types as the visit menu`() {
        val rates = mapOf("30Minute" to "25", "Half-Day 6Hrs" to "100", "Overnight" to "150", "Consultation" to "")
        val menu = durationsFromServiceRates(rates).associateBy { it.id }
        // The service NAME is the id, the length comes off the name, the rate off the map.
        assertEquals(Duration("30Minute", "30Minute", 30.0, 25.0, "visit"), menu.getValue("30Minute"))
        assertEquals(360.0, menu.getValue("Half-Day 6Hrs").minutes, 0.001)
        // Named overnight is an overnight; a 6-hour day stay is still a visit.
        assertEquals("overnight", menu.getValue("Overnight").kind)
        assertEquals("visit", menu.getValue("Half-Day 6Hrs").kind)
        // No price and no stated length is 0, not a dropped row.
        assertEquals(0.0, menu.getValue("Consultation").price, 0.001)
        assertEquals(0.0, menu.getValue("Consultation").minutes, 0.001)
    }

    @Test
    fun `durationsFromServiceRates takes a stated duration over the one in the name`() {
        val menu = durationsFromServiceRates(mapOf("Overnight" to "150"), mapOf("Overnight" to "720"))
        assertEquals(720.0, menu[0].minutes, 0.001)
    }

    @Test
    fun `alignPinnedToDurations repoints a pinned visit whose length left the menu`() {
        val menu = durationsFromServiceRates(mapOf("30Minute" to "25", "Overnight" to "150"))
        // The shipped default pins `d2`, an id from the deleted builder-owned menu.
        val aligned = alignPinnedToDurations(DEFAULT_COVERAGE_RULES, menu)
        assertEquals("30Minute", aligned.pinnedTimes[0].durationId)
        assertEquals(DEFAULT_COVERAGE_RULES.pinnedTimes[0].label, aligned.pinnedTimes[0].label)
        assertEquals(DEFAULT_COVERAGE_RULES.pinnedTimes[0].time, aligned.pinnedTimes[0].time)
        // Nothing to point at leaves it blank rather than inventing a length.
        assertEquals("", alignPinnedToDurations(DEFAULT_COVERAGE_RULES, emptyList()).pinnedTimes[0].durationId)
    }

    @Test
    fun `alignPinnedToDurations leaves a pinned visit that already resolves`() {
        val menu = durationsFromServiceRates(mapOf("30Minute" to "25", "60Minute" to "45"))
        val rules = DEFAULT_COVERAGE_RULES.copy(pinnedTimes = listOf(PinnedTime("p", "Meds", "12:00", "60Minute")))
        assertEquals("60Minute", alignPinnedToDurations(rules, menu).pinnedTimes[0].durationId)
    }

    @Test
    fun `todayIso is the device's calendar date`() {
        assertEquals("2026-09-09", todayIso(java.time.LocalDate.of(2026, 9, 9)))
    }

    @Test
    fun `buildDayPatterns is empty for a degenerate window and drops empty suggestions`() {
        assertTrue(buildDayPatterns(DEFAULT_DURATIONS, emptyList(), 6.0, "14:00", "11:00").isEmpty())
        assertTrue(buildDayPatterns(DEFAULT_DURATIONS, emptyList(), 6.0, "11:00", "14:00").isEmpty())
    }

    @Test
    fun `buildDayPatterns only fills with visit-kind durations`() {
        val patterns = buildDayPatterns(DEFAULT_DURATIONS, emptyList(), 3.0, "07:00", "22:00")
        assertTrue(patterns.isNotEmpty())
        for (p in patterns) for (tp in p.touchpoints) {
            assertEquals("visit", DEFAULT_DURATIONS.first { it.id == tp.durationId }.kind)
        }
    }

    @Test
    fun `visitsFromPattern seeds a template`() {
        val p = buildDayPatterns(DEFAULT_DURATIONS, listOf(PinnedTime("p", "Meds", "12:00", "d3")), 12.0, "07:00", "22:00").first()
        val visits = visitsFromPattern(p)
        assertEquals(p.touchpoints.size, visits.size)
        assertEquals(720, visits.first().time)
    }

    @Test
    fun `priceDay bills a bare visit at list price`() {
        val (items, total) = priceDay(listOf(Visit("v", 720, "d3", "Lunch")), DEFAULT_DURATIONS, Coverage(null, null, false))
        assertEquals(35.0, total, 0.001) // d3 = $35
        assertTrue(!items[0].free)
    }

    @Test
    fun `a visit inside the overnight window is covered`() {
        val p = pkg(overnightNights = mapOf(0 to true), overnightStart = "21:00", overnightBufferHours = 2.0)
        val cov = coverageForDay(p, 0, 2, overnight)
        assertEquals(19 * 60, cov.eveningFrom) // 21:00 minus 2h buffer
        val (items, _) = priceDay(listOf(Visit("v", 20 * 60, "d3", "Evening")), DEFAULT_DURATIONS, cov)
        assertTrue(items[0].free)
        assertEquals(0.0, items[0].price, 0.001)
    }

    @Test
    fun `the morning after an overnight grants a bonus free visit`() {
        val cov = Coverage(null, null, true)
        val (items, total) = priceDay(
            listOf(Visit("a", 8 * 60, "d3", "AM"), Visit("b", 12 * 60, "d3", "Noon")),
            DEFAULT_DURATIONS, cov,
        )
        assertTrue(items[0].bonus)
        assertEquals(0.0, items[0].price, 0.001)
        assertEquals(35.0, total, 0.001) // only the second visit is billed
    }

    @Test
    fun `pricePackage applies a discount to the summed days`() {
        val p = pkg(visits = listOf(Visit("v", 12 * 60, "d3", "Lunch")), overnightNights = mapOf(0 to true, 1 to true), discountPct = 10.0)
        val priced = pricePackage(p, PriceContext(3, 2, DEFAULT_DURATIONS, overnight))
        assertEquals(3, priced.rows.size)
        assertTrue(priced.subtotal > 0)
        assertEquals(priced.subtotal * 0.1, priced.discount, 0.001)
        assertEquals(priced.subtotal - priced.discount, priced.total, 0.001)
    }

    @Test
    fun `gapWarnings flags a bare day with a gap wider than the max`() {
        val warns = gapWarnings(listOf(Visit("a", 8 * 60, "d1", "AM")), "07:00", "22:00", 4.0, Coverage(null, null, false))
        assertTrue(warns.isNotEmpty())
    }

    @Test
    fun `quoteText renders a client-facing per-day quote`() {
        val p = pkg(visits = listOf(Visit("v", 12 * 60, "d3", "Lunch"))).copy(name = "Balanced")
        val priced = pricePackage(p, PriceContext(2, 1, DEFAULT_DURATIONS, overnight))
        val text = quoteText(QuoteInput("Rex", "2026-07-01", 2, p, priced))
        assertTrue(text.contains("TribeTails — Coverage Package"))
        assertTrue(text.contains("Prepared for: Rex"))
        assertTrue(text.contains("Balanced · 2 days"))
        assertTrue(text.contains("Lunch (45-min visit)"))
        assertTrue(text.contains("Total"))
    }

    @Test
    fun `minutesToTime formats a 12h label`() {
        assertEquals("7:30 AM", minutesToTime(450.0))
        assertEquals("10:00 PM", minutesToTime(1320.0))
        assertNull(timeToMinutes("nope"))
    }
}
