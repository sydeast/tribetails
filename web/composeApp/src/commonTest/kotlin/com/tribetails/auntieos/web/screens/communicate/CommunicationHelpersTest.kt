package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.CallLog
import com.tribetails.auntieos.web.data.EmailMessage
import com.tribetails.auntieos.web.data.SmsMessage
import com.tribetails.auntieos.web.data.VoicemailLog
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CommunicationHelpersTest {

    // ---- summaryLine ----
    @Test fun summaryLine_prefers_tldr() {
        assertEquals("Short.", summaryLine("  Short.  ", "long raw summary", 100))
    }

    @Test fun summaryLine_falls_back_to_truncated_raw() {
        val raw = "x".repeat(50)
        assertEquals("x".repeat(20) + "…", summaryLine("", raw, 20))
    }

    @Test fun summaryLine_short_raw_not_truncated() {
        assertEquals("hello", summaryLine("   ", "hello", 20))
    }

    @Test fun summaryLine_both_blank_is_empty() {
        assertEquals("", summaryLine("", "   ", 20))
    }

    // ---- latestCommunication ----
    @Test fun latest_picks_newest_across_channels() {
        val sms = listOf(SmsMessage(_id = "s1", timestamp = "2026-06-01T00:00:00Z", body = "old sms"))
        val emails = listOf(EmailMessage(_id = "e1", timestamp = "2026-06-10T00:00:00Z", subject = "newest"))
        val calls = listOf(CallLog(_id = "c1", timestamp = "2026-06-05T00:00:00Z", transcript = "call"))
        val vms = listOf(VoicemailLog(_id = "v1", timestamp = "", transcript = "no ts ignored"))
        val latest = latestCommunication(sms, emails, calls, vms)
        assertEquals("email", latest?.channel)
        assertEquals("2026-06-10T00:00:00Z", latest?.timestamp)
        assertEquals("newest", latest?.snippet)
    }

    @Test fun latest_null_when_all_empty() {
        assertNull(latestCommunication(emptyList(), emptyList(), emptyList(), emptyList()))
    }

    @Test fun latest_ignores_blank_timestamps() {
        val sms = listOf(SmsMessage(_id = "s1", timestamp = "", body = "ignored"))
        assertNull(latestCommunication(sms, emptyList(), emptyList(), emptyList()))
    }

    // ---- commsBoxState ----
    @Test fun box_ai_recap_when_flag_on_and_recap_present() {
        val s = commsBoxState(flagOn = true, recap = "where things left off", latest = null)
        assertTrue(s is CommsBoxState.AiRecap && s.recap == "where things left off")
    }

    @Test fun box_raw_disclosed_when_flag_on_but_recap_blank() {
        val latest = LatestComm("sms", "2026-06-10T00:00:00Z", "hi")
        val s = commsBoxState(flagOn = true, recap = "   ", latest = latest)
        assertTrue(s is CommsBoxState.RawLatest && s.disclosedFallback)
    }

    @Test fun box_raw_not_disclosed_when_flag_off() {
        val latest = LatestComm("sms", "2026-06-10T00:00:00Z", "hi")
        val s = commsBoxState(flagOn = false, recap = null, latest = latest)
        assertTrue(s is CommsBoxState.RawLatest && !s.disclosedFallback)
    }

    @Test fun box_empty_when_nothing() {
        assertTrue(commsBoxState(flagOn = true, recap = null, latest = null) is CommsBoxState.Empty)
    }
}
