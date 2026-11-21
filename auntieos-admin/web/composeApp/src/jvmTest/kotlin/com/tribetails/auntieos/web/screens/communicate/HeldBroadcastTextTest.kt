package com.tribetails.auntieos.web.screens.communicate

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1834 (operator ruling, 2026-11-20): a broadcast sent while notices to
 * households are switched off is held, and the owner reads why in plain words.
 * Same sentences as the web and Android.
 */
class HeldBroadcastTextTest {

    @Test
    fun `switched off, the sentence says it was not sent, will not go later, and how to send it`() {
        val text = broadcastErrorText("held_household_notices_off")
        assertEquals(
            "Held. Notices to households are switched off. This broadcast was not sent and will not go out later. " +
                "To send it, switch on \"Send notices to households\" in Settings, under Notifications, then send it again.",
            text,
        )
        assertTrue(text.startsWith(HELD_SEND_PREFIX))
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
        assertNull(heldBroadcastText("no_recipients"))
        assertEquals("That audience has no kinfolk right now. Nothing was sent.", broadcastErrorText("no_recipients"))
        assertFalse(broadcastErrorText("broadcast_all_failed").startsWith(HELD_SEND_PREFIX))
    }

    @Test
    fun `no sentence carries a token or an em dash`() {
        for (token in listOf("held_household_notices_off", "held_notice_turned_off", "held_household_notices_unreadable")) {
            val s = heldBroadcastText(token)!!
            assertFalse(s.contains("_"), s)
            assertFalse(s.contains("—"), s)
        }
    }
}
