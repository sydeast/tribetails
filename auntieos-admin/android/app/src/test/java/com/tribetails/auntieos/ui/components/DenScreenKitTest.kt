package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit coverage for the shared DenScreenKit helpers, mirroring the web app's
 * DenScreenKitTest so the cross-platform parity contract (service->tone mapping,
 * status labels, time formatting, time-of-day greeting) is pinned on both sides.
 */
class DenScreenKitTest {

    @Test
    fun serviceTone_maps_known_services() {
        assertEquals(AuntieStatusTone.Teal, serviceTone("Dog Walk"))
        assertEquals(AuntieStatusTone.Orange, serviceTone("Drop-In Visit"))
        assertEquals(AuntieStatusTone.Purple, serviceTone("House Sit"))
        assertEquals(AuntieStatusTone.Purple, serviceTone("Overnight"))
        assertEquals(AuntieStatusTone.Success, serviceTone("Meet & Greet"))
    }

    @Test
    fun serviceTone_is_case_insensitive_and_has_default() {
        assertEquals(AuntieStatusTone.Teal, serviceTone("WALK"))
        assertEquals(AuntieStatusTone.Orange, serviceTone("")) // unknown -> default orange
        assertEquals(AuntieStatusTone.Orange, serviceTone("grooming"))
    }

    /**
     * AO-19, mirrored from the web DenScreenKitTest. "sit" used to be matched as
     * a bare substring, so it hit the "sit" inside "vi-SIT-" and painted every
     * visit house-sitting purple. Android carried the identical defect.
     *
     * "Drop-In Visit" passed even when broken, but only because "drop" is
     * checked first. A type named just "Visit" had nothing to save it.
     */
    @Test
    fun serviceTone_does_not_match_sit_inside_visit() {
        assertEquals(AuntieStatusTone.Orange, serviceTone("visit_60"))
        assertEquals(AuntieStatusTone.Orange, serviceTone("Visit"))
        assertEquals(AuntieStatusTone.Orange, serviceTone("Pet Visit"))
        assertEquals(AuntieStatusTone.Orange, serviceTone("VISIT_30"))
        assertEquals(AuntieStatusTone.Orange, serviceTone("Drop-In Visit"))
    }

    @Test
    fun serviceTone_still_matches_real_sitting_services() {
        assertEquals(AuntieStatusTone.Purple, serviceTone("House Sit"))
        assertEquals(AuntieStatusTone.Purple, serviceTone("Pet Sitting"))
        assertEquals(AuntieStatusTone.Purple, serviceTone("sit"))
        assertEquals(AuntieStatusTone.Purple, serviceTone("Housesitting")) // via "house"
        assertEquals(AuntieStatusTone.Purple, serviceTone("Overnight"))
    }

    @Test
    fun statusLabel_maps_lifecycle_states() {
        assertEquals("done", statusLabel("COMPLETED"))
        assertEquals("on the way", statusLabel("ON_MY_WAY"))
        assertEquals("arrived", statusLabel("ARRIVED"))
        assertEquals("departed", statusLabel("DEPARTED"))
        assertEquals("cancelled", statusLabel("CANCELLED"))
        assertEquals("scheduled", statusLabel("SCHEDULED"))
        assertEquals("scheduled", statusLabel("anything-else"))
    }

    @Test
    fun greetingForHour_buckets_the_day() {
        assertEquals("Good morning", greetingForHour(0))
        assertEquals("Good morning", greetingForHour(11))
        assertEquals("Good afternoon", greetingForHour(12))
        assertEquals("Good afternoon", greetingForHour(16))
        assertEquals("Good evening", greetingForHour(17))
        assertEquals("Good evening", greetingForHour(23))
    }

    @Test
    fun formatTime_renders_12h_with_am_pm() {
        assertEquals("6:38p", formatTime("2025-08-06T18:38:00"))
        assertEquals("7:18a", formatTime("2025-08-28T07:18:00"))
        assertEquals("12:00p", formatTime("2025-08-10T12:00:00")) // noon -> 12p
        assertEquals("12:30a", formatTime("2025-08-10T00:30:00")) // midnight -> 12a
    }

    @Test
    fun formatTime_echoes_unparsable_input() {
        assertEquals("", formatTime(""))
        assertEquals("not-a-date", formatTime("not-a-date"))
    }
}
