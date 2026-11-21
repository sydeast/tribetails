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
}
