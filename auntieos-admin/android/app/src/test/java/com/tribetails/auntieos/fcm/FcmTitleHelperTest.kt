package com.tribetails.auntieos.fcm

import org.junit.Assert.assertEquals
import org.junit.Test

class FcmTitleHelperTest {

    @Test
    fun voicemailTitle_personal_line_is_tagged() {
        assertEquals(
            "[Personal] New Voicemail from +15551234567",
            FcmTitleHelper.voicemailTitle("+15551234567", "personal")
        )
    }

    @Test
    fun voicemailTitle_business_line_is_untagged() {
        assertEquals(
            "New Voicemail from +15551234567",
            FcmTitleHelper.voicemailTitle("+15551234567", "business")
        )
    }

    @Test
    fun voicemailTitle_missing_line_is_untagged() {
        assertEquals(
            "New Voicemail from +15551234567",
            FcmTitleHelper.voicemailTitle("+15551234567", null)
        )
    }

    @Test
    fun voicemailTitle_unknown_line_value_is_untagged() {
        assertEquals(
            "New Voicemail from Unknown",
            FcmTitleHelper.voicemailTitle("Unknown", "garbage")
        )
    }

    @Test
    fun callbackRequestTitle_personal_line_is_tagged() {
        assertEquals(
            "[Personal] Callback from +15551234567",
            FcmTitleHelper.callbackRequestTitle("+15551234567", "personal")
        )
    }

    @Test
    fun callbackRequestTitle_missing_line_is_untagged() {
        assertEquals(
            "Callback from Unknown",
            FcmTitleHelper.callbackRequestTitle("Unknown", null)
        )
    }
}
