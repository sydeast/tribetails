package com.tribetails.auntieos.web.screens.inbox

import com.tribetails.auntieos.web.data.VoicemailLog
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * S8 / issue #581. `VoicemailLog.toEntry()` carries `replyStatus` into
 * `InboxEntry.statusHint`, which is what gates the Dismiss button
 * (`canDismissVoicemail` in `InboxScreen`) and the "dismissed" pip in
 * `MetaRow`. Parity with the React admin's `voicemailEntry`
 * (`lib/inboxChannels.test.ts`) and the Android `VoicemailLog.toEntry()`
 * mapper (`android/.../ui/inbox/VoicemailToEntryTest.kt`).
 */
class VoicemailToEntryTest {

    @Test
    fun dismissedIsCarriedNotFlattened() {
        val entry = VoicemailLog(_id = "vm1", replyStatus = "dismissed").toEntry()
        assertEquals("dismissed", entry.statusHint)
    }

    @Test
    fun dismissedIsLowerCasedRegardlessOfWriterCasing() {
        // `replyStatus` casing is unenforced across the Twilio webhooks, both
        // admin clients and the python reconcile pipeline, so the reader
        // normalizes rather than trusting any one writer's casing.
        val entry = VoicemailLog(_id = "vm2", replyStatus = "DISMISSED").toEntry()
        assertEquals("dismissed", entry.statusHint)
    }

    @Test
    fun unreadIsCarried() {
        val entry = VoicemailLog(_id = "vm3", replyStatus = "unread").toEntry()
        assertEquals("unread", entry.statusHint)
    }

    @Test
    fun readFlattensToBlank() {
        // `read` still needs no pip of its own on this row shape (unlike React's
        // ChannelRow), and nothing gates on it specifically, so there is no
        // reason to carry it through.
        assertEquals("", VoicemailLog(_id = "vm4", replyStatus = "read").toEntry().statusHint)
    }

    /**
     * Issue #581: this used to flatten to "" alongside `read`, which is
     * exactly what let Dismiss (gated only on `!= "dismissed"`) render on an
     * already-replied voicemail and, if pressed, blank `repliedAt`/
     * `replyLogId` with no way back. `replied` matches no pip check in
     * `MetaRow`, so carrying it through changes nothing visually - it only
     * gives `canDismissVoicemail` something to gate on.
     */
    @Test
    fun repliedIsCarriedNotFlattened() {
        val entry = VoicemailLog(_id = "vm5", replyStatus = "replied").toEntry()
        assertEquals("replied", entry.statusHint)
    }

    @Test
    fun repliedIsLowerCasedRegardlessOfWriterCasing() {
        val entry = VoicemailLog(_id = "vm6", replyStatus = "REPLIED").toEntry()
        assertEquals("replied", entry.statusHint)
    }

    // ── canDismissVoicemail: the truth table Dismiss's visibility is gated on ──

    @Test
    fun dismissIsOfferedFromUnread() {
        assertTrue(canDismissVoicemail("unread"))
    }

    @Test
    fun dismissIsOfferedFromABlankHint() {
        assertTrue(canDismissVoicemail(""))
    }

    @Test
    fun dismissIsRefusedOnceAlreadyDismissed() {
        assertFalse(canDismissVoicemail("dismissed"))
    }

    @Test
    fun dismissIsRefusedOnceAlreadyReplied() {
        assertFalse(canDismissVoicemail("replied"))
    }
}
