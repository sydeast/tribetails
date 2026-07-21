package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.screens.booking.sortServiceTypesByDuration
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * B9: KinCare type chips rendered in Map-iteration order (scrambled — 60Min, Half-Day,
 * 90Min, 45Min, 30Min, 2Hrs). Operator wanted them reordered; with no explicit order
 * given, default to ascending by parsed duration. Unknowns sort last, stable.
 */
class ServiceTypeSortTest {

    @Test
    fun `orders the operator's real types shortest-first`() {
        val input = listOf("60Minute", "Half-Day 6Hrs", "90Minute", "45Minute", "30Minute", "2Hrs")
        assertEquals(
            listOf("30Minute", "45Minute", "60Minute", "90Minute", "2Hrs", "Half-Day 6Hrs"),
            sortServiceTypesByDuration(input),
        )
    }

    @Test
    fun `hours beat minutes`() {
        assertEquals(listOf("45Minute", "1Hr", "2Hours"), sortServiceTypesByDuration(listOf("2Hours", "1Hr", "45Minute")))
    }

    @Test
    fun `unparseable durations sort last but keep their relative order`() {
        assertEquals(
            listOf("30Minute", "Consultation", "Meet & Greet"),
            sortServiceTypesByDuration(listOf("Consultation", "30Minute", "Meet & Greet")),
        )
    }
}
