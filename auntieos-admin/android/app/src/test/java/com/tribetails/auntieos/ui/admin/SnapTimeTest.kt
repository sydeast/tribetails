package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #9 (2026-06-08): the reschedule picker snaps the chosen time to 15 min when
 * BusinessSettings.snapRescheduleTo15Min is on. snapTimeStringTo15 is the pure rounder.
 */
class SnapTimeTest {

    @Test fun rounds_to_nearest_quarter_hour() {
        assertEquals("10:00", snapTimeStringTo15("10:00"))
        assertEquals("10:00", snapTimeStringTo15("10:07")) // <7.5 -> down
        assertEquals("10:15", snapTimeStringTo15("10:08")) // >=7.5 -> up
        assertEquals("10:15", snapTimeStringTo15("10:14"))
        assertEquals("10:30", snapTimeStringTo15("10:23"))
        assertEquals("11:00", snapTimeStringTo15("10:53")) // rolls the hour
    }

    @Test fun unparseable_input_is_returned_unchanged() {
        assertEquals("not-a-time", snapTimeStringTo15("not-a-time"))
        assertEquals("", snapTimeStringTo15(""))
    }

    @Test fun midnight_wrap_is_safe() {
        assertEquals("00:00", snapTimeStringTo15("23:58")) // 24:00 wraps to 00:00
    }
}
