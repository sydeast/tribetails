package com.tribetails.auntieos.ui.inbox
import java.util.Base64
/**
 * What the `getRecordingAudio` admin callable hands the Inbox player (#1573).
 *
 * Twilio's stored recording link needs the account's credentials, so the app
 * can neither stream it nor hand it to a browser. The server fetches the audio
 * and returns the bytes; a stored link that is not a Twilio recording needs no
 * credential and comes back as [Url].
 */
sealed interface RecordingAudio {
    class Bytes(val bytes: ByteArray, val contentType: String) : RecordingAudio
    data class Url(val url: String) : RecordingAudio
}
/** Maps the Inbox channel to the callable's `kind`, or null for a channel with no recording. */
internal fun recordingKindOf(channel: Channel): String? = when (channel) {
    Channel.Voicemail -> "voicemail"
    Channel.Call -> "call"
    else -> null
}
/** Decodes the callable payload. Null when the answer carries no playable audio. Pure. */
internal fun decodeRecordingAudio(raw: Map<String, Any?>?): RecordingAudio? {
    when (raw?.get("source") as? String) {
        "external" -> {
            val url = (raw["url"] as? String).orEmpty()
            return if (url.startsWith("https://")) RecordingAudio.Url(url) else null
        }
        "twilio" -> {
            val b64 = (raw["base64"] as? String).orEmpty()
            if (b64.isEmpty()) return null
            val bytes = runCatching { Base64.getDecoder().decode(b64) }.getOrNull() ?: return null
            if (bytes.isEmpty()) return null
            return RecordingAudio.Bytes(bytes, (raw["contentType"] as? String)?.ifBlank { null } ?: "audio/mpeg")
        }
        else -> return null
    }
}
/** `m:ss` for the player's position and length. Negative or unknown reads as 0:00. Pure. */
internal fun formatPlayerClock(ms: Int): String {
    val total = if (ms < 0) 0 else ms / 1000
    return "${total / 60}:${(total % 60).toString().padStart(2, '0')}"
}

/**
 * A US number as people write it, `(619) 500-1530`, when [raw] is a plain +1 or
 * 10-digit number. Anything else (an email address, a short code, an
 * international number) comes back untouched: guessing a grouping for a number
 * this does not understand would print a wrong number. Mirrors `displayContact`
 * in the React admin's src/lib/inboxChannels.ts. Pure.
 */
internal fun displayContact(raw: String): String {
    val t = raw.trim()
    if ('@' in t) return raw
    val digits = t.filter { it.isDigit() }
    val national = when {
        t.startsWith("+") -> if (digits.length == 11 && digits.startsWith("1")) digits.drop(1) else return raw
        digits.length == 10 -> digits
        digits.length == 11 && digits.startsWith("1") -> digits.drop(1)
        else -> return raw
    }
    // Only digits and the usual separators: a number with letters is not a number.
    if (t.any { !(it.isDigit() || it in "+ ().-") }) return raw
    return "(${national.substring(0, 3)}) ${national.substring(3, 6)}-${national.substring(6)}"
}
