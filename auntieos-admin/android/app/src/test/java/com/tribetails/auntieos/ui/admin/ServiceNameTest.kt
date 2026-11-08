package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.serviceTone
import org.junit.Assert.assertEquals
import org.junit.Test

/** #1592: a stored service key reads as the operator's KinCare name, the web rule exactly. */
class ServiceNameTest {
    private val rates = mapOf("30Minute" to "25", "60Minute" to "45")

    @Test fun `matches the catalog key on letters and digits alone`() {
        assertEquals("30Minute", bookingServiceName("30minute", rates))
        assertEquals("30Minute", bookingServiceName("30 Minute", rates))
    }

    @Test fun `reaches the one KinCare that runs as long as the label says`() {
        assertEquals("60Minute", bookingServiceName("visit_60", rates))
        assertEquals("60Minute", bookingServiceName("60Mins", rates))
    }

    @Test fun `two KinCares of the same length resolve to nothing, not a guess`() {
        val twin = rates + ("Dog Walk 60Min" to "40")
        assertEquals("visit_60", bookingServiceName("visit_60", twin))
    }

    @Test fun `unresolved keeps the stored text and blank reads Visit`() {
        assertEquals("Off-Book Visit", bookingServiceName("Off-Book Visit", rates))
        assertEquals("Visit", bookingServiceName("  ", rates))
        assertEquals("Visit", bookingServiceName(null, rates))
    }

    @Test fun `a KinTale row names its service and leaves a blank one blank`() {
        assertEquals("60Minute", kinTaleServiceLabel("visit_60", rates))
        assertEquals("", kinTaleServiceLabel(null, rates))
        assertEquals("", kinTaleServiceLabel(" ", rates))
    }

    @Test fun `a stored duration counts for the length match`() {
        val named = mapOf("Consultation" to "20", "Walk" to "30")
        assertEquals("Walk", bookingServiceName("visit_45", named, mapOf("Walk" to "45")))
    }

    @Test fun `a stored key is coloured by the KinCare it resolves to, the legend swatch's key`() {
        val catalog = ServiceCatalog(mapOf("Dog walk" to "45"), mapOf("Dog walk" to "60"))
        assertEquals(AuntieStatusTone.Orange, serviceTone("visit_60"))
        assertEquals(AuntieStatusTone.Teal, bookingServiceTone("visit_60", catalog))
        assertEquals(serviceTone(catalog.nameOf("visit_60")), bookingServiceTone("visit_60", catalog))
    }
    @Test fun `the catalog names with both maps, as the legend does`() {
        // The rows used the rates alone, so a length kept only in
        // `serviceDurations` named the legend and left the row raw.
        val catalog = ServiceCatalog(mapOf("Dog walk" to "45"), mapOf("Dog walk" to "60"))
        assertEquals("Dog walk", catalog.nameOf("visit_60"))
        assertEquals("visit_60", bookingServiceName("visit_60", catalog.serviceRates))
    }
    @Test fun `an unresolved service keeps its own colour`() {
        val catalog = ServiceCatalog(mapOf("Dog walk" to "45"))
        assertEquals(AuntieStatusTone.Purple, bookingServiceTone("Overnight sit", catalog))
    }
}
