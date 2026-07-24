package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-logic tests for the Coverage Package Builder domain, mirroring the web
 * `coveragePackage.test.ts` so both platforms are pinned to the same behaviour.
 */
class CoveragePackageTest {

    private fun rules(
        wakeStart: String = "07:00",
        wakeEnd: String = "22:00",
        maxGapHours: Double = 6.0,
        pinned: List<PinnedTime> = emptyList(),
    ) = CoverageRules(wakeStart, wakeEnd, maxGapHours, pinned)

    // ── daysBetween ──────────────────────────────────────────────────────────

    @Test
    fun `daysBetween counts inclusively`() {
        assertEquals(1, daysBetween("2026-07-01", "2026-07-01"))
        assertEquals(5, daysBetween("2026-07-01", "2026-07-05"))
        assertEquals(4, daysBetween("2026-07-30", "2026-08-02"))
    }

    @Test
    fun `daysBetween is zero for unset or reversed ranges`() {
        assertEquals(0, daysBetween("", "2026-07-05"))
        assertEquals(0, daysBetween("2026-07-05", ""))
        assertEquals(0, daysBetween("2026-07-05", "2026-07-01"))
    }

    // ── time helpers ─────────────────────────────────────────────────────────

    @Test
    fun `timeToMinutes parses and rejects`() {
        assertEquals(0, timeToMinutes("00:00"))
        assertEquals(450, timeToMinutes("07:30"))
        assertEquals(1320, timeToMinutes("22:00"))
        assertNull(timeToMinutes(""))
        assertNull(timeToMinutes("nope"))
    }

    @Test
    fun `minutesToTime formats a 12h label`() {
        assertEquals("12:00 AM", minutesToTime(0.0))
        assertEquals("7:30 AM", minutesToTime(450.0))
        assertEquals("12:30 PM", minutesToTime(750.0))
        assertEquals("10:00 PM", minutesToTime(1320.0))
    }

    // ── buildDayPatterns ─────────────────────────────────────────────────────

    @Test
    fun `no patterns when the day window is empty or reversed`() {
        assertTrue(buildDayPatterns(DEFAULT_DURATIONS, rules(wakeEnd = "07:00"), false, "d7").isEmpty())
        assertTrue(buildDayPatterns(DEFAULT_DURATIONS, rules(wakeStart = "", wakeEnd = ""), false, "d7").isEmpty())
    }

    @Test
    fun `never leaves a gap wider than the max`() {
        val r = rules(maxGapHours = 4.0)
        val maxGapMin = r.maxGapHours * 60
        val patterns = buildDayPatterns(DEFAULT_DURATIONS, r, false, "d7")
        assertTrue(patterns.isNotEmpty())
        val start = timeToMinutes(r.wakeStart)!!.toDouble()
        val end = timeToMinutes(r.wakeEnd)!!.toDouble()
        for (p in patterns) {
            val times = (listOf(start) + p.touchpoints.map { it.time } + listOf(end)).sorted()
            for (i in 0 until times.size - 1) {
                assertTrue("gap exceeded max", times[i + 1] - times[i] <= maxGapMin + 0.001)
            }
        }
    }

    @Test
    fun `includes every pinned visit at its time, priced at its own duration`() {
        val r = rules(pinned = listOf(PinnedTime("p1", "Meds", "12:00", "d3")))
        val patterns = buildDayPatterns(DEFAULT_DURATIONS, r, false, "d7")
        assertTrue(patterns.isNotEmpty())
        for (p in patterns) {
            val pinned = p.touchpoints.firstOrNull { it.isPinned }
            assertTrue("pinned visit present", pinned != null)
            assertEquals(720.0, pinned!!.time, 0.001)
            assertEquals("Meds", pinned.label)
            assertEquals(28.0, pinned.price, 0.001) // d3 price, not the fill duration
        }
    }

    @Test
    fun `overnight cost and label only when requested`() {
        val withOn = buildDayPatterns(DEFAULT_DURATIONS, rules(), true, "d7")
        val withoutOn = buildDayPatterns(DEFAULT_DURATIONS, rules(), false, "d7")
        assertTrue(withOn.isNotEmpty())
        for (p in withOn) {
            assertEquals("Overnight (12hr)", p.overnightLabel)
            assertEquals(150.0, p.overnightCost, 0.001)
        }
        for (p in withoutOn) {
            assertNull(p.overnightLabel)
            assertEquals(0.0, p.overnightCost, 0.001)
        }
    }

    @Test
    fun `orders cheapest-first and dedupes identical strategies`() {
        val single = listOf(Duration("only", "30-min", 30.0, 20.0))
        assertEquals(1, buildDayPatterns(single, rules(maxGapHours = 4.0), false, "d7").size)

        val many = buildDayPatterns(DEFAULT_DURATIONS, rules(maxGapHours = 3.0), false, "d7")
        for (i in 0 until many.size - 1) {
            assertTrue("not cheapest-first", many[i].dayTotal <= many[i + 1].dayTotal)
        }
    }

    @Test
    fun `emits nothing when the rules need no visits`() {
        // The exact prod config that showed a phantom $0 "Lean" card: an 11:00–14:00
        // window (3h) is narrower than the 6h max gap and there are no pinned visits.
        val degenerate = rules(wakeStart = "11:00", wakeEnd = "14:00", maxGapHours = 6.0)
        assertTrue(buildDayPatterns(DEFAULT_DURATIONS, degenerate, false, "d7").isEmpty())
    }

    @Test
    fun `still emits an overnight-only schedule when overnight is on`() {
        val degenerate = rules(wakeStart = "11:00", wakeEnd = "14:00", maxGapHours = 6.0)
        val patterns = buildDayPatterns(DEFAULT_DURATIONS, degenerate, true, "d7")
        assertEquals(1, patterns.size)
        assertTrue(patterns[0].touchpoints.isEmpty())
        assertEquals(150.0, patterns[0].overnightCost, 0.001)
        assertEquals(150.0, patterns[0].dayTotal, 0.001)
    }

    // ── quoteText ────────────────────────────────────────────────────────────

    @Test
    fun `quoteText renders a clean client-facing quote`() {
        // Large max gap + one pinned visit -> a single deterministic pattern
        // (pinned Meds at 12:00, priced at d3 = $28), so the quote is stable.
        val r = rules(maxGapHours = 12.0, pinned = listOf(PinnedTime("p1", "Meds", "12:00", "d3")))
        val pattern = buildDayPatterns(DEFAULT_DURATIONS, r, false, "d7")[0]
        val text = quoteText(QuoteInput("Rex", "2026-07-01", "2026-07-03", 3, pattern))
        assertTrue(text.contains("TribeTails — Coverage Package"))
        assertTrue(text.contains("Prepared for: Rex"))
        assertTrue(text.contains("12:00 PM"))
        assertTrue(text.contains("Meds (45-min visit)"))
        assertTrue(text.contains("Per day   $28.00"))
        assertTrue(text.contains("Total (3 days)   $84.00"))
    }

    @Test
    fun `quoteText omits the client line when no name is given`() {
        val r = rules(maxGapHours = 12.0, pinned = listOf(PinnedTime("p1", "Meds", "12:00", "d3")))
        val pattern = buildDayPatterns(DEFAULT_DURATIONS, r, false, "d7")[0]
        val text = quoteText(QuoteInput("", "", "", 1, pattern))
        assertTrue(!text.contains("Prepared for"))
        assertTrue(text.contains("Total (1 day)   $28.00"))
    }
}
