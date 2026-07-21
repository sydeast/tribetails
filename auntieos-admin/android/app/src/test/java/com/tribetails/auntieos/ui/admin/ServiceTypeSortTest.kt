package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * B9 (A8): service-type labels ordered ascending by parsed duration; unknowns last,
 * stable. Mirror of the web ServiceTypeSortTest so the two platforms order identically.
 */
class ServiceTypeSortTest {

    @Test fun ordersRealTypesShortestFirst() {
        val input = listOf("60Minute", "Half-Day 6Hrs", "90Minute", "45Minute", "30Minute", "2Hrs")
        assertEquals(
            listOf("30Minute", "45Minute", "60Minute", "90Minute", "2Hrs", "Half-Day 6Hrs"),
            sortServiceTypesByDuration(input),
        )
    }

    @Test fun hoursBeatMinutes() {
        assertEquals(
            listOf("45Minute", "1Hr", "2Hours"),
            sortServiceTypesByDuration(listOf("2Hours", "1Hr", "45Minute")),
        )
    }

    @Test fun unparseableDurationsSortLastStable() {
        assertEquals(
            listOf("30Minute", "Consultation", "Meet & Greet"),
            sortServiceTypesByDuration(listOf("Consultation", "30Minute", "Meet & Greet")),
        )
    }
}
