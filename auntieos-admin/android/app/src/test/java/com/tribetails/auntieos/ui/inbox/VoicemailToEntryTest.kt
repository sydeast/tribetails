package com.tribetails.auntieos.ui.inbox

import com.tribetails.auntieos.data.model.VoicemailLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Issue #581: `VoicemailLog.toEntry()` carries `replyStatus` into
 * `InboxEntry.statusHint`, which is what gates the Mark read / Dismiss buttons
 * in `InboxScreen`'s modal. Before this, `replied` flattened to the SAME
 * blank hint as `read`, so Dismiss (gated only on `!= "dismissed"`) could not
 * tell an already-replied voicemail apart from an unreplied one and rendered
 * on it - a stray tap then blanked `repliedAt`/`replyLogId` with no way back.
 * Parity with the React admin's `voicemailEntry` (`lib/inboxChannels.test.ts`)
 * and the desktop admin's `VoicemailLog.toEntry()` mapper
 * (`web/composeApp/.../inbox/VoicemailToEntryTest.kt`).
 */
class VoicemailToEntryTest {

    @Test
    fun unreadIsCarried() {
        val entry = VoicemailLog(id = "vm1", replyStatus = "unread").toEntry()
        assertEquals("unread", entry.statusHint)
    }

    @Test
    fun repliedIsCarriedNotFlattened() {
        val entry = VoicemailLog(id = "vm2", replyStatus = "replied").toEntry()
        assertEquals("replied", entry.statusHint)
    }

    @Test
    fun dismissedIsCarried() {
        val entry = VoicemailLog(id = "vm3", replyStatus = "dismissed").toEntry()
        assertEquals("dismissed", entry.statusHint)
    }

    @Test
    fun readFlattensToBlank() {
        // `read` still needs no pip of its own on this row shape (unlike
        // React's ChannelRow). Unlike `replied`, nothing gates on `read`
        // specifically, so there is no reason to carry it through.
        assertEquals("", VoicemailLog(id = "vm4", replyStatus = "read").toEntry().statusHint)
    }

    @Test
    fun repliedIsLowerCasedRegardlessOfWriterCasing() {
        // `replyStatus` casing is unenforced across the Twilio webhooks, both
        // admin clients and the python reconcile pipeline, so the reader
        // normalizes rather than trusting any one writer's casing.
        val entry = VoicemailLog(id = "vm5", replyStatus = "REPLIED").toEntry()
        assertEquals("replied", entry.statusHint)
    }

    // ── canDismissVoicemail: the truth table Dismiss's visibility is gated on ──

    @Test
    fun `dismiss is offered from unread`() {
        assertTrue(canDismissVoicemail("unread"))
    }

    @Test
    fun `dismiss is offered from a blank hint (read, or unknown)`() {
        assertTrue(canDismissVoicemail(""))
    }

    @Test
    fun `dismiss is refused once already dismissed`() {
        assertFalse(canDismissVoicemail("dismissed"))
    }

    @Test
    fun `dismiss is refused once already replied`() {
        assertFalse(canDismissVoicemail("replied"))
    }
}
