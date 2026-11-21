package com.tribetails.auntieos.domain

import com.tribetails.auntieos.ui.communicate.broadcastErrorText
import com.tribetails.auntieos.ui.marketing.BlastStatus
import com.tribetails.auntieos.ui.marketing.MarketingBlastRow
import com.tribetails.auntieos.ui.marketing.blastErrorText
import com.tribetails.auntieos.ui.marketing.blastMeta
import com.tribetails.auntieos.ui.marketing.decodeBlasts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * #1834 (operator ruling, 2026-11-20): a broadcast or a marketing blast sent
 * while notices to households are switched off is held, and the owner reads
 * why in plain words. Same sentences as the web and the desktop console.
 */
class HeldSendTextTest {

    @Test
    fun `switched off, the broadcast sentence says it was not sent, will not go later, and how to send it`() {
        val text = broadcastErrorText("held_household_notices_off")
        assertEquals(
            "Held. Notices to households are switched off. This broadcast was not sent and will not go out later. " +
                "To send it, switch on \"Send notices to households\" in Settings, under Notifications, then send it again.",
            text,
        )
        assertTrue(text.startsWith(HELD_SEND_PREFIX))
    }

    @Test
    fun `the blast sentences name the blast and scheduling`() {
        assertTrue(blastErrorText("held_household_notices_off").contains("This blast was not scheduled and will not go out later"))
        assertTrue(blastErrorText("held_household_notices_off").endsWith("then schedule it again."))
        assertEquals(
            "Held. This campaign is turned off in Settings, under Notifications. This blast was not scheduled and will not go out later.",
            blastErrorText("held_notice_turned_off"),
        )
    }

    @Test
    fun `turned off and unreadable each have their own sentence`() {
        assertEquals(
            "Held. Broadcasts are turned off in Settings, under Notifications. This broadcast was not sent and will not go out later.",
            broadcastErrorText("held_notice_turned_off"),
        )
        assertEquals(
            "Held. The setting for notices to households could not be read. This broadcast was not sent. Try again in a minute.",
            broadcastErrorText("held_household_notices_unreadable"),
        )
    }

    @Test
    fun `NEGATIVE - other errors keep their own words and are not drawn as a hold`() {
        assertNull(heldSendText("no_recipients", HeldSendKind.Broadcast))
        assertFalse(broadcastErrorText("no_recipients").startsWith(HELD_SEND_PREFIX))
        assertEquals("That blast was already cancelled.", blastErrorText("already_cancelled"))
    }

    @Test
    fun `no sentence carries a stored key, a token or an em dash`() {
        for (token in listOf("held_household_notices_off", "held_notice_turned_off", "held_household_notices_unreadable")) {
            for (kind in HeldSendKind.values()) {
                val s = heldSendText(token, kind)!!
                assertFalse(s, s.contains("_"))
                assertFalse(s, s.contains("—"))
            }
        }
    }

    @Test
    fun `a blast row takes copies held at the send time out of sent and names them`() {
        assertEquals("3 sent, 1 suppressed", blastCountsText(3, 1, 0))
        assertEquals("1 sent, 1 suppressed, 2 held and not sent", blastCountsText(3, 1, 2))
        assertEquals("0 sent, 0 suppressed, 9 held and not sent", blastCountsText(4, 0, 9))
    }

    @Test
    fun `the list decodes heldAtSend and the row line shows it`() {
        val rows = decodeBlasts(
            mapOf(
                "blasts" to listOf(
                    mapOf("id" to "b1", "key" to "newsletter.announcement", "status" to "sent", "fireAtMs" to 1L, "dispatched" to 5, "suppressed" to 0, "heldAtSend" to 5),
                    mapOf("id" to "b2", "key" to "survey.event", "status" to "sent", "fireAtMs" to 1L, "dispatched" to 2),
                ),
            ),
        )
        assertEquals(5, rows.first { it.id == "b1" }.heldAtSend)
        assertEquals(0, rows.first { it.id == "b2" }.heldAtSend)
        val row = rows.first { it.id == "b1" }
        assertTrue(blastMeta(row, ZoneId.of("UTC")).contains("0 sent, 0 suppressed, 5 held and not sent"))
        val plain = MarketingBlastRow(
            id = "b3", key = "survey.event", title = "", fireAtMs = 1L, status = BlastStatus.Sent,
            audienceDescription = "", matched = 1, noLinkedAccount = 0, dispatched = 1, suppressed = 0, failed = 0,
        )
        assertFalse(blastMeta(plain, ZoneId.of("UTC")).contains("held"))
    }
}
