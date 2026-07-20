package com.tribetails.auntieos.web.screens.kintales

import kotlin.test.Test
import kotlin.test.assertEquals

/** Send-button label binds the real recipient, not a hardcoded "the Thornes" sample. */
class KinTaleSendLabelTest {

    @Test
    fun bindsRealRecipient() {
        assertEquals("Send to Wanda Thorne", kinTaleSendLabel("Wanda Thorne"))
    }

    @Test
    fun fallsBackToNeutralWhenBlank() {
        assertEquals("Send KinTale", kinTaleSendLabel(""))
        assertEquals("Send KinTale", kinTaleSendLabel("   ".trim()))
    }
}
