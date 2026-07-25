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

    @Test fun largestStatedDurationWins() {
        assertEquals(360, serviceDurationMinutes("Half-Day 6Hrs"))
        assertEquals(45, serviceDurationMinutes("45 min"))
        assertEquals(null, serviceDurationMinutes("Consultation"))
    }

    /**
     * The booking-request dialog reads its services from business_settings.serviceRates
     * (not the legacy base_services collection). Same fixture as the web
     * NewBookingDialog test, so both platforms offer the same chips in the same order.
     */
    @Test fun serviceOptionsComeFromServiceRatesInDurationOrder() {
        val options = serviceOptionsFromRates(
            linkedMapOf(
                "60Minute" to "40",
                "Half-Day 6Hrs" to "100",
                "90Minute" to "55",
                "30Minute" to "25",
                "Consultation" to "",
                "  " to "10",
            ),
        )
        assertEquals(
            listOf("30Minute", "60Minute", "90Minute", "Half-Day 6Hrs", "Consultation"),
            options.map { it.name },
        )
        assertEquals(
            listOf("30Minute · \$25", "60Minute · \$40", "90Minute · \$55", "Half-Day 6Hrs · \$100", "Consultation"),
            options.map { serviceChipLabel(it) },
        )
    }

    @Test fun emptyServiceRatesYieldNoOptions() {
        assertEquals(emptyList<ServiceOption>(), serviceOptionsFromRates(emptyMap()))
    }
}
