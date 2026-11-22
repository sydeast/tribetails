package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.data.model.CallLog
import com.tribetails.auntieos.data.model.EmailMessage
import com.tribetails.auntieos.data.model.SmsMessage
import com.tribetails.auntieos.data.model.VoicemailLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CommunicationHelpersTest {

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

    @Test fun latest_picks_newest_across_channels() {
        val sms = listOf(SmsMessage(id = "s1", timestamp = "2026-06-01T00:00:00Z", body = "old sms"))
        val emails = listOf(EmailMessage(id = "e1", timestamp = "2026-06-10T00:00:00Z", subject = "newest"))
        val calls = listOf(CallLog(id = "c1", timestamp = "2026-06-05T00:00:00Z", transcript = "call"))
        val vms = listOf(VoicemailLog(id = "v1", timestamp = "", transcript = "ignored"))
        val latest = latestCommunication(sms, emails, calls, vms)
        assertEquals("email", latest?.channel)
        assertEquals("2026-06-10T00:00:00Z", latest?.timestamp)
        assertEquals("newest", latest?.snippet)
    }

    // #1878: a household whose only messages are in the thread is not "no messages".
    @Test fun latest_counts_the_thread_when_the_logs_are_empty() {
        val latest = latestCommunication(
            emptyList(), emptyList(), emptyList(), emptyList(),
            LatestThreadMessage("See you Sunday", 1_793_000_000_000),
        )
        assertEquals("thread", latest?.channel)
        assertEquals("See you Sunday", latest?.snippet)
        assertEquals("MyTribe message", commsChannelLabel(latest!!.channel))
    }

    @Test fun latest_keeps_a_newer_log_over_an_older_thread_message() {
        val sms = listOf(SmsMessage(id = "s1", timestamp = "2030-01-01T00:00:00Z", body = "newer text"))
        val latest = latestCommunication(sms, emptyList(), emptyList(), emptyList(), LatestThreadMessage("older", 1_000_000))
        assertEquals("sms", latest?.channel)
    }

    @Test fun comms_day_is_the_local_day() {
        val chicago = java.time.ZoneId.of("America/Chicago")
        assertEquals("2026-11-01", commsLocalDay("2026-11-02T02:30:00Z", chicago))
        assertEquals("2026-11-02", commsLocalDay("2026-11-02", chicago))
        assertEquals("not a dateTtime", commsLocalDay("not a dateTtime", chicago))
    }

    @Test fun latest_null_when_all_empty() {
        assertNull(latestCommunication(emptyList(), emptyList(), emptyList(), emptyList()))
    }

    @Test fun box_ai_recap_when_flag_on_and_recap_present() {
        val s = commsBoxState(flagOn = true, recap = "left off", latest = null)
        assertTrue(s is CommsBoxState.AiRecap && (s as CommsBoxState.AiRecap).recap == "left off")
    }

    @Test fun box_raw_disclosed_when_flag_on_but_recap_blank() {
        val latest = LatestComm("sms", "2026-06-10T00:00:00Z", "hi")
        val s = commsBoxState(flagOn = true, recap = "   ", latest = latest)
        assertTrue(s is CommsBoxState.RawLatest && (s as CommsBoxState.RawLatest).disclosedFallback)
    }

    @Test fun box_raw_not_disclosed_when_flag_off() {
        val latest = LatestComm("sms", "2026-06-10T00:00:00Z", "hi")
        val s = commsBoxState(flagOn = false, recap = null, latest = latest)
        assertTrue(s is CommsBoxState.RawLatest && !(s as CommsBoxState.RawLatest).disclosedFallback)
    }

    @Test fun box_empty_when_nothing() {
        assertTrue(commsBoxState(flagOn = true, recap = null, latest = null) is CommsBoxState.Empty)
    }
}
