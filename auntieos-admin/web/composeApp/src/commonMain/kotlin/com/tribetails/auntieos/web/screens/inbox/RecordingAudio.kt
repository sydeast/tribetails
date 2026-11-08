package com.tribetails.auntieos.web.screens.inbox
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
/**
 * What the `getRecordingAudio` admin callable hands the Inbox player (#1573).
 *
 * Twilio's stored recording link needs the account's credentials, so a browser
 * or player cannot open it. The server fetches the audio and returns the bytes;
 * a stored link that is not a Twilio recording needs no credential and comes
 * back as [Url].
 */
sealed interface RecordingAudio {
    class Bytes(val bytes: ByteArray, val contentType: String) : RecordingAudio
    data class Url(val url: String) : RecordingAudio
}
private val recordingJson = Json { ignoreUnknownKeys = true; isLenient = true }
/** Maps the Inbox channel to the callable's `kind`, or null for a channel with no recording. */
internal fun recordingKindOf(channel: Channel): String? = when (channel) {
    Channel.Voicemail -> "voicemail"
    Channel.Call -> "call"
    else -> null
}
/** File extension for saved audio. Pure. */
fun recordingExtension(contentType: String): String = if (contentType.contains("wav", ignoreCase = true)) "wav" else "mp3"
/** Decodes the callable payload. Throws when it carries nothing playable, so the caller reports why. Pure. */
@OptIn(ExperimentalEncodingApi::class)
fun decodeRecordingAudio(dataJson: String): RecordingAudio {
    val o = recordingJson.parseToJsonElement(dataJson).jsonObject
    return when (o["source"]?.jsonPrimitive?.contentOrNull) {
        "external" -> {
            val url = o["url"]?.jsonPrimitive?.contentOrNull.orEmpty()
            require(url.startsWith("https://")) { "This recording is not at an address that can be played." }
            RecordingAudio.Url(url)
        }
        "twilio" -> {
            val b64 = o["base64"]?.jsonPrimitive?.contentOrNull.orEmpty()
            require(b64.isNotEmpty()) { "This recording has no audio to play." }
            val bytes = Base64.decode(b64)
            require(bytes.isNotEmpty()) { "This recording has no audio to play." }
            RecordingAudio.Bytes(bytes, o["contentType"]?.jsonPrimitive?.contentOrNull?.ifBlank { null } ?: "audio/mpeg")
        }
        else -> error("This recording has no audio to play.")
    }
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
