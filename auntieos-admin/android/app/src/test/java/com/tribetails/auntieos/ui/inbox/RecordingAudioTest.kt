package com.tribetails.auntieos.ui.inbox
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
/** #1573: the Inbox player gets audio from the server, never the Twilio link. */
class RecordingAudioTest {
    private fun b64(s: ByteArray) = Base64.getEncoder().encodeToString(s)
    @Test fun decodesTwilioBytes() {
        val bytes = byteArrayOf(0x49, 0x44, 0x33, 0, 1, 2)
        val a = decodeRecordingAudio(
            mapOf("ok" to true, "source" to "twilio", "contentType" to "audio/mpeg", "base64" to b64(bytes), "bytes" to 6),
        )
        assertTrue(a is RecordingAudio.Bytes)
        a as RecordingAudio.Bytes
        assertArrayEquals(bytes, a.bytes)
        assertEquals("audio/mpeg", a.contentType)
    }
    @Test fun defaultsTheContentTypeToMpeg() {
        val a = decodeRecordingAudio(mapOf("source" to "twilio", "base64" to b64(byteArrayOf(1))))
        assertEquals("audio/mpeg", (a as RecordingAudio.Bytes).contentType)
    }
    @Test fun passesAnExternalHttpsLinkThrough() {
        assertEquals(
            RecordingAudio.Url("https://example.test/a.mp3"),
            decodeRecordingAudio(mapOf("source" to "external", "url" to "https://example.test/a.mp3")),
        )
    }
    @Test fun refusesAnythingNotPlayable() {
        assertNull(decodeRecordingAudio(null))
        assertNull(decodeRecordingAudio(emptyMap()))
        assertNull(decodeRecordingAudio(mapOf("source" to "twilio", "base64" to "")))
        assertNull(decodeRecordingAudio(mapOf("source" to "twilio", "base64" to "!!not base64!!")))
        assertNull(decodeRecordingAudio(mapOf("source" to "external", "url" to "http://insecure.test/a.mp3")))
        assertNull(decodeRecordingAudio(mapOf("source" to "external", "url" to "javascript:alert(1)")))
        assertNull(decodeRecordingAudio(mapOf("source" to "somewhere-else", "url" to "https://x.test/")))
    }
    @Test fun onlyVoicemailsAndCallsHaveRecordings() {
        assertEquals("voicemail", recordingKindOf(Channel.Voicemail))
        assertEquals("call", recordingKindOf(Channel.Call))
        assertNull(recordingKindOf(Channel.Sms))
        assertNull(recordingKindOf(Channel.Email))
        assertNull(recordingKindOf(Channel.All))
    }
    @Test fun playerClockCountsUpFromZero() {
        assertEquals("0:00", formatPlayerClock(0))
        assertEquals("0:00", formatPlayerClock(-1))
        assertEquals("0:05", formatPlayerClock(5_400))
        assertEquals("1:05", formatPlayerClock(65_000))
        assertEquals("12:00", formatPlayerClock(720_000))
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
