package com.tribetails.auntieos.ui.kintales

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** #1817: a sent KinTale never reads "Sent via pending." */
class SentViaWordsTest {

    @Test
    fun theSendPathMarkersReadMyTribe() {
        assertEquals("MyTribe", sentViaWords("pending"))
        assertEquals("MyTribe", sentViaWords("catalog"))
        assertEquals("MyTribe", sentViaWords(" Pending "))
    }

    @Test
    fun aRealChannelReadsAsAWord() {
        assertEquals("email", sentViaWords("EMAIL"))
        assertEquals("text", sentViaWords("sms"))
        assertEquals("push", sentViaWords("push"))
    }

    @Test
    fun backfillMarkersAndBlankReadImported() {
        assertEquals("imported", sentViaWords("legacy_orphan"))
        assertEquals("imported", sentViaWords("legacy_visit_logs"))
        assertEquals("imported", sentViaWords("   "))
    }

    @Test
    fun aStoredValueItDoesNotKnowIsNeverPrinted() {
        assertNull(sentViaWords("dispatch_v2"))
        assertNull(sentViaWords("kin_care_reports"))
    }

    @Test
    fun sentAtReadsAsADateAndTimeOnTheBusinessClock() {
        // #2551: May is daylight time in Chicago, so 09:50Z reads 04:50.
        val chicago = java.time.ZoneId.of("America/Chicago")
        assertEquals("May 30 · 04:50", sentAtWords("2026-05-30T09:50:00Z", chicago, currentYear = 2026))
        assertEquals("Nov 10, 2026 · 22:32", sentAtWords("2026-11-11T04:32:00Z", chicago, currentYear = 2027))
    }

    @Test
    fun aSentAtThatDoesNotReadIsNeverPrinted() {
        val chicago = java.time.ZoneId.of("America/Chicago")
        assertNull(sentAtWords("not a time", chicago))
        assertNull(sentAtWords("", chicago))
        assertNull(sentAtWords(null, chicago))
    }
}
