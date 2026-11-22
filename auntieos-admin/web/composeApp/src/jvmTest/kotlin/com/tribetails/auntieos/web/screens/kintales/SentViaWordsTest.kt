package com.tribetails.auntieos.web.screens.kintales

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

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
        val chicago = kotlinx.datetime.TimeZone.of("America/Chicago")
        assertEquals("May 30, 2026 04:50", sentAtWords("2026-05-30T09:50:00Z", chicago, currentYear = 2026))
        assertEquals("Nov 10, 2026 22:32", sentAtWords("2026-11-11T04:32:00Z", chicago, currentYear = 2027))
    }

    @Test
    fun aSentAtThatDoesNotReadIsNeverPrinted() {
        val chicago = kotlinx.datetime.TimeZone.of("America/Chicago")
        assertNull(sentAtWords("not a time", chicago))
        assertNull(sentAtWords("", chicago))
    }
}
