package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.formatTime
import com.tribetails.auntieos.web.ui.components.greetingForHour
import com.tribetails.auntieos.web.ui.components.serviceTone
import com.tribetails.auntieos.web.ui.components.statusLabel
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Unit coverage for the shared DenScreenKit helpers that drive cross-screen
 * (and cross-platform, once android mirrors them) parity: service->tone mapping,
 * status labels, time formatting, and the time-of-day greeting.
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
     * AO-19. "sit" used to be matched as a bare substring, so it hit the "sit"
     * inside "vi-SIT-" and painted every visit house-sitting purple.
     *
     * It survived 44 days and three sightings (06-01 audit, 06-23 punchlist B7,
     * 07-15 AO-19) because the 06-01 audit concluded the OPPOSITE, and that
     * wrong conclusion was written into ScheduleScreen.kt as a doc comment
     * asserting these keys resolve to Orange. Readers believed the comment and
     * stopped looking. These assertions are what the comment claimed; now they
     * are enforced instead of asserted in prose.
     *
     * "Drop-In Visit" passed even when broken, but only by luck: "drop" is
     * checked before "sit". A type named just "Visit" had nothing to save it.
     */
    @Test
    fun serviceTone_does_not_match_sit_inside_visit() {
        assertEquals(AuntieStatusTone.Orange, serviceTone("visit_60"))
        assertEquals(AuntieStatusTone.Orange, serviceTone("Visit"))
        assertEquals(AuntieStatusTone.Orange, serviceTone("Pet Visit"))
        assertEquals(AuntieStatusTone.Orange, serviceTone("VISIT_30"))
        // unchanged, and no longer dependent on "drop" being checked first
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
