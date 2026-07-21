package com.tribetails.auntieos.ui.kintales

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure-helper tests for [kinTaleSendLabel] (spec 10 item 1.1), mirroring the web
 * KinTaleSendLabelTest: the send label binds the real recipient household and
 * never hardcodes a sample name; blank falls back to neutral copy.
 */
class KinTaleSendLabelTest {

    @Test
    fun bindsRealHousehold() {
        assertEquals("Send to the Thorne household", kinTaleSendLabel("the Thorne household"))
    }

    @Test
    fun neutralWhenBlank() {
        assertEquals("Send KinTale", kinTaleSendLabel(""))
    }
}
