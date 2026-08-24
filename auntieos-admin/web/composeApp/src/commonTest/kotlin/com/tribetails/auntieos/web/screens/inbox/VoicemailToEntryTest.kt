package com.tribetails.auntieos.web.screens.inbox

import com.tribetails.auntieos.web.data.VoicemailLog
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * S8. `VoicemailLog.toEntry()` carries `replyStatus` into `InboxEntry.statusHint`,
 * which is what gates the Dismiss button (`canDismiss` in `InboxScreen`'s
 * `ThreadActionsCard`) and the "dismissed" pip in `MetaRow`. Parity with the React
 * admin's `voicemailEntry` (`lib/inboxChannels.test.ts`) and the Android
 * `VoicemailLog.toEntry()` mapper (covered indirectly through `InboxViewModelTest`).
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
    fun readAndRepliedFlattenToBlank() {
        // Neither `read` nor `replied` needs a pip of its own on this row shape:
        // there is no "replied" pill here (unlike the React admin's ChannelRow),
        // so both collapse to the same blank hint a fresh voicemail never had.
        assertEquals("", VoicemailLog(_id = "vm4", replyStatus = "read").toEntry().statusHint)
        assertEquals("", VoicemailLog(_id = "vm5", replyStatus = "replied").toEntry().statusHint)
    }
}
