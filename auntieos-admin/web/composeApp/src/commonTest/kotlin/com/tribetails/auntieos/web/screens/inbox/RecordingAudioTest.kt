package com.tribetails.auntieos.web.screens.inbox
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
/** #1573: the console plays audio the server fetched, never the Twilio link. */
@OptIn(ExperimentalEncodingApi::class)
class RecordingAudioTest {
    @Test fun decodesTwilioBytes() {
        val bytes = byteArrayOf(0x49, 0x44, 0x33, 0, 1, 2)
        val a = decodeRecordingAudio(
            """{"ok":true,"source":"twilio","contentType":"audio/mpeg","base64":"${Base64.encode(bytes)}","bytes":6}""",
        )
        assertTrue(a is RecordingAudio.Bytes)
        assertContentEquals(bytes, (a as RecordingAudio.Bytes).bytes)
        assertEquals("audio/mpeg", a.contentType)
    }
    @Test fun passesAnExternalHttpsLinkThrough() {
        assertEquals(
            RecordingAudio.Url("https://example.test/a.mp3"),
            decodeRecordingAudio("""{"ok":true,"source":"external","url":"https://example.test/a.mp3"}"""),
        )
    }
    @Test fun refusesAnythingNotPlayable() {
        assertFailsWith<IllegalArgumentException> { decodeRecordingAudio("""{"source":"twilio","base64":""}""") }
        assertFailsWith<IllegalArgumentException> { decodeRecordingAudio("""{"source":"external","url":"http://x.test/a.mp3"}""") }
        assertFailsWith<IllegalArgumentException> { decodeRecordingAudio("""{"source":"external","url":"javascript:alert(1)"}""") }
        assertFailsWith<IllegalStateException> { decodeRecordingAudio("""{"ok":true}""") }
    }
    @Test fun onlyVoicemailsAndCallsHaveRecordings() {
        assertEquals("voicemail", recordingKindOf(Channel.Voicemail))
        assertEquals("call", recordingKindOf(Channel.Call))
        assertNull(recordingKindOf(Channel.Sms))
        assertNull(recordingKindOf(Channel.Email))
        assertNull(recordingKindOf(Channel.All))
    }
    @Test fun savedFileGetsTheRightExtension() {
        assertEquals("wav", recordingExtension("audio/wav"))
        assertEquals("wav", recordingExtension("audio/x-wav"))
        assertEquals("mp3", recordingExtension("audio/mpeg"))
    }

    @Test fun aCallerNoHouseholdMatchesReadsAsAPhoneNumber() {
        assertEquals("(619) 500-1530", displayContact("+16195001530"))
        assertEquals("(619) 500-1530", displayContact("16195001530"))
        assertEquals("(619) 500-1530", displayContact("6195001530"))
        assertEquals("(619) 500-1530", displayContact("(619) 500-1530"))
    }
    @Test fun displayContactLeavesWhatItDoesNotUnderstandAlone() {
        for (raw in listOf("", "unknown", "a@b.co", "+442071838750", "12345", "+1619500153", "+161950015301", "client:abc")) {
            assertEquals(raw, displayContact(raw))
        }
    }
}
