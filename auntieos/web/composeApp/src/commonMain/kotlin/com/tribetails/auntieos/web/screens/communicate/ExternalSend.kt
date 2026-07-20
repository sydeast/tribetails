package com.tribetails.auntieos.web.screens.communicate

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// ─────────────────────────────────────────────────────────────────────────────
// External send: pure validation + decode helpers.
//
// All decision logic lives here (not in the composable) so it is unit-tested on
// pure JVM in commonTest. The composable + FirestoreClient methods consume these.
//
// The server (MyTribe functions/src/admin/sendExternalMessage.ts) is the source
// of truth and re-validates everything; these client-side checks are a fast,
// honest pre-flight so the operator gets immediate feedback before a round-trip.
// ─────────────────────────────────────────────────────────────────────────────

/** Channel for an external one-off send. Wire value matches the callable arg. */
enum class ExternalChannel(val wire: String, val label: String) {
    Email("email", "Email"),
    Sms("sms", "Text"),
}

/**
 * Outcome of client-side recipient validation. [Valid] carries the trimmed value
 * that should be sent; the rest are fail-loud reasons surfaced to the operator.
 */
sealed interface RecipientValidation {
    data class Valid(val trimmed: String) : RecipientValidation
    data object Empty : RecipientValidation
    data object BadEmail : RecipientValidation
    data object BadPhone : RecipientValidation
}

/**
 * Conservative email shape check, mirrored from the server's regex
 * (`^[^\s@]+@[^\s@]+\.[^\s@]+$`): exactly one run of non-space/@ chars, an @, a
 * dotted host. Deliberately strict so an obvious typo is caught before the call.
 */
fun isValidExternalEmail(raw: String): Boolean {
    val t = raw.trim()
    if (t.isEmpty()) return false
    val re = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")
    return re.matches(t)
}

/**
 * E.164-ish phone check matching the server's intent: optional leading '+', then
 * 8..15 digits once non-digits are stripped. Accepts common separators (spaces,
 * dashes, parens) in the typed form. The server re-normalizes to canonical E.164.
 */
fun isValidExternalPhone(raw: String): Boolean {
    val t = raw.trim()
    if (t.isEmpty()) return false
    // Only +, digits, and the usual separators are allowed in the typed form.
    if (!Regex("^\\+?[0-9 ()\\-.]+$").matches(t)) return false
    val digits = t.filter { it.isDigit() }
    return digits.length in 8..15
}

/** Pure recipient validation for the chosen channel. */
fun validateRecipient(channel: ExternalChannel, raw: String): RecipientValidation {
    val t = raw.trim()
    if (t.isEmpty()) return RecipientValidation.Empty
    return when (channel) {
        ExternalChannel.Email -> if (isValidExternalEmail(t)) RecipientValidation.Valid(t) else RecipientValidation.BadEmail
        ExternalChannel.Sms -> if (isValidExternalPhone(t)) RecipientValidation.Valid(t) else RecipientValidation.BadPhone
    }
}

/**
 * Whole-form readiness. Returns the first blocking reason, or null when the form
 * is ready to submit. Subject is required for email only (matches the server).
 */
fun externalSendBlocker(
    channel: ExternalChannel,
    recipient: String,
    subject: String,
    body: String,
): String? {
    when (val v = validateRecipient(channel, recipient)) {
        is RecipientValidation.Valid -> Unit
        RecipientValidation.Empty -> return "Add a recipient first."
        RecipientValidation.BadEmail -> return "That does not look like a valid email address."
        RecipientValidation.BadPhone -> return "That does not look like a valid phone number. Use the full number with country code."
    }
    if (channel == ExternalChannel.Email && subject.trim().isEmpty()) {
        return "Email needs a subject."
    }
    if (body.trim().isEmpty()) return "Write a message body first."
    return null
}

/** Result of a successful sendExternalMessage call (decoded from the callable). */
data class ExternalSendResult(
    val channel: String,
    val providerMessageId: String,
    val recipientRedacted: String,
)

/** Result of a successful suppressExternalRecipient call. */
data class SuppressResult(
    val channel: String,
    val recipientRedacted: String,
)

private val externalSendJson = Json { ignoreUnknownKeys = true; isLenient = true }

/**
 * Pure decode of the sendExternalMessage body
 * `{ok, channel, providerMessageId, recipientRedacted}`. Throws on malformed
 * JSON so the caller maps it to a fail-loud error; omitted fields decode to "".
 */
fun decodeExternalSendResult(dataJson: String): ExternalSendResult {
    val o = externalSendJson.parseToJsonElement(dataJson).jsonObject
    return ExternalSendResult(
        channel = o["channel"]?.jsonPrimitive?.contentOrNull ?: "",
        providerMessageId = o["providerMessageId"]?.jsonPrimitive?.contentOrNull ?: "",
        recipientRedacted = o["recipientRedacted"]?.jsonPrimitive?.contentOrNull ?: "",
    )
}

/**
 * Pure decode of the suppressExternalRecipient body
 * `{ok, channel, recipientRedacted}`. Throws on malformed JSON.
 */
fun decodeSuppressResult(dataJson: String): SuppressResult {
    val o = externalSendJson.parseToJsonElement(dataJson).jsonObject
    return SuppressResult(
        channel = o["channel"]?.jsonPrimitive?.contentOrNull ?: "",
        recipientRedacted = o["recipientRedacted"]?.jsonPrimitive?.contentOrNull ?: "",
    )
}

/**
 * True when a server error message is the opt-out consent gate. The callable
 * throws failed-precondition with the literal message `recipient_opted_out`;
 * different platforms wrap that prefix differently, so match by substring.
 */
fun isOptedOutError(message: String): Boolean =
    message.contains("recipient_opted_out", ignoreCase = true)

/**
 * Map a raw callable error message to operator-facing text. The opt-out gate is
 * surfaced clearly and distinctly; everything else is passed through verbatim so
 * we never hide a provider/validation failure (fail loud, never fake).
 */
fun externalSendErrorText(message: String): String =
    if (isOptedOutError(message)) {
        "This recipient has opted out. Nothing was sent. Remove their suppression before sending again."
    } else {
        message
    }
