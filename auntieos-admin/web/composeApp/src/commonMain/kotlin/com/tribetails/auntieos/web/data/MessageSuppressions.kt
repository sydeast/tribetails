package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * #1102: the do-not-send list (`message_suppressions`) through its two
 * owner-only callables (MyTribe `functions/src/admin/messageSuppressions.ts`,
 * #1083). The collection is denied to every client in the rules, so there is no
 * direct Firestore path. The twins are `auntieos-admin/src/api/messageSuppressions.ts`
 * and Android `MessageSuppressionRepository`; this console has no generated
 * contracts, so the shapes are hand-written and every decoder ignores keys it
 * does not know.
 *
 * `recipient` is the FULL address. Clear needs it and the server refuses the
 * masked form, so a row carries both: show `recipient`, send `recipient` back.
 *
 * Clear removes a hard BOUNCE and never an opt-out: the opt-out is the
 * household's own consent choice. A row that is both keeps its opt-out, and a
 * row that is only an opt-out has nothing to clear.
 */
data class Suppression(
    val recipient: String,
    val recipientRedacted: String,
    /** "email" or "sms". */
    val channel: String,
    /** "hard_bounce" or "opt_out". */
    val reason: String,
    /** "smtp2go" or "admin". */
    val source: String,
    val suppressedAtMs: Long,
    /** The household opted out, whether or not the address also bounced. */
    val optedOut: Boolean,
    /** The smtp2go webhook event id of the bounce, or null. */
    val eventId: String?,
) {
    /** Only a bounce can be cleared. */
    val clearable: Boolean get() = reason == "hard_bounce"
}

data class SuppressionPage(val items: List<Suppression>, val nextCursor: String?)

data class ClearSuppressionResult(
    val channel: String,
    val recipientRedacted: String,
    /** True when the address also had an opt-out, which Clear leaves in place. */
    val optOutKept: Boolean,
)

private val suppressionJson = Json { ignoreUnknownKeys = true; isLenient = true }

/** [reason] is "all", "hard_bounce" or "opt_out". */
fun listMessageSuppressionsPayload(reason: String, cursor: String?): JsonObject = buildJsonObject {
    put("reason", reason)
    if (cursor != null) put("cursor", cursor)
}

fun clearMessageSuppressionPayload(recipient: String): JsonObject = buildJsonObject {
    put("recipient", recipient.trim())
}

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

/** A row with no address is dropped; every other field has a safe default. Throws on malformed JSON. */
fun decodeSuppressionPage(body: String): SuppressionPage {
    val o = suppressionJson.parseToJsonElement(body).jsonObject
    val items = (o["items"] as? JsonArray).orEmpty().mapNotNull { el ->
        val m = el as? JsonObject ?: return@mapNotNull null
        val recipient = m.str("recipient")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        val reason = if (m.str("reason") == "hard_bounce") "hard_bounce" else "opt_out"
        Suppression(
            recipient = recipient,
            recipientRedacted = m.str("recipientRedacted").orEmpty(),
            channel = if (m.str("channel") == "sms") "sms" else "email",
            reason = reason,
            source = if (m.str("source") == "smtp2go") "smtp2go" else "admin",
            suppressedAtMs = (m["suppressedAtMs"] as? JsonPrimitive)?.longOrNull ?: 0L,
            // An opt-out only row is an opt-out by definition, whatever an older deploy sent.
            optedOut = (m["optedOut"] as? JsonPrimitive)?.booleanOrNull == true || reason == "opt_out",
            eventId = m.str("eventId")?.takeIf { it.isNotEmpty() },
        )
    }
    return SuppressionPage(items, o.str("nextCursor")?.takeIf { it.isNotEmpty() })
}

/** Throws on malformed JSON. */
fun decodeClearSuppressionResult(body: String): ClearSuppressionResult {
    val o = suppressionJson.parseToJsonElement(body).jsonObject
    return ClearSuppressionResult(
        channel = if (o.str("channel") == "sms") "sms" else "email",
        recipientRedacted = o.str("recipientRedacted").orEmpty(),
        optOutKept = (o["optOutKept"] as? JsonPrimitive)?.booleanOrNull == true,
    )
}
