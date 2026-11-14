package com.tribetails.auntieos.web.screens

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * #1816, #1838, #2027, #1841: what an admin action tells the household, said
 * truthfully BEFORE it (the confirm) and AFTER it (the toast), from the
 * server only.
 *
 * The confirm asks `previewVisitNotification` with the action's notification
 * key (the dispatcher's own dry run), and the toast reads the `notice` the
 * action's callable returned. A server that predates `notice` returns none,
 * and the toast then claims nothing about the household. The desktop console
 * is the owner's, so its lines are the owner's (no Auntie wording). Web
 * (`auntieos-admin/src/lib/householdNoticeWords.ts`) and Android
 * (`domain/HouseholdNoticeWords.kt`) carry the same sentences.
 */

/** The notices an admin confirm can ask about (server `PREVIEW_NOTICE_KEYS`). */
object HouseholdNoticeKeys {
    const val KINTALE = "kintale.published"
    const val CANCEL = "kincare.booking.cancel"
    const val CHANGED = "kincare.changed"
    const val NOTE = "kincare.note.auntie"
    const val CONFIRM = "kincare.booking.confirm"
}

/** What happened to the household's copy, as the callables return it. */
data class HouseholdNotice(
    val told: Boolean,
    val reason: String?,
    val name: String?,
    val channels: List<String>,
)

/** The confirm's state: still asking, no usable answer, or the server's answer. */
sealed interface HouseholdNoticePreview {
    data object Checking : HouseholdNoticePreview
    data object Unknown : HouseholdNoticePreview
    data class Ready(
        val willNotify: Boolean,
        val reason: String?,
        val name: String?,
        val channels: List<String>,
    ) : HouseholdNoticePreview
}

private val CHANNEL_WORDS = mapOf("email" to "an email", "sms" to "a text", "push" to "a phone notification")

/** "an email", "an email and a text", "an email, a text and a phone notification". */
fun channelWords(channels: List<String>): String {
    val words = channels.mapNotNull { CHANNEL_WORDS[it] }
    if (words.size <= 1) return words.joinToString("")
    return words.dropLast(1).joinToString(", ") + " and " + words.last()
}

private fun who(serverName: String?, fallback: String): String {
    val named = serverName?.trim().orEmpty()
    if (named.isNotEmpty()) return named
    val held = fallback.trim()
    return if (held.isNotEmpty()) held else "the household"
}

private fun opening(name: String): String = name.replaceFirstChar { it.uppercase() }

private fun whyNot(reason: String?, name: String): String? = when (reason) {
    "household_has_no_portal_account" -> "$name has no portal account"
    "household_prefs_suppressed" -> "this notice is turned off for $name"
    "household_notices_off" -> "notices to households are off in Settings"
    "session_has_no_routing_ids" -> "this visit is not linked to a booking"
    else -> null
}

/** The confirm's line, future tense, or null when it should say nothing (the server could not be asked). */
fun householdNoticeConfirmLine(preview: HouseholdNoticePreview, household: String): String? = when (preview) {
    HouseholdNoticePreview.Checking -> "Checking who will be told."
    HouseholdNoticePreview.Unknown -> null
    is HouseholdNoticePreview.Ready -> {
        val name = who(preview.name, household)
        if (preview.willNotify) {
            val how = channelWords(preview.channels)
            if (how.isEmpty()) "${opening(name)} will see it in their notifications list only." else "${opening(name)} will get $how."
        } else if (preview.reason == "not_a_household_notice") {
            "No notice goes to $name for this."
        } else {
            whyNot(preview.reason, name)?.let { "Nobody will be told: $it." }
        }
    }
}

/** The toast's line, past tense, from what the server did. "" when the server said nothing. */
fun householdNoticeResultLine(notice: HouseholdNotice?, household: String): String {
    if (notice == null) return ""
    val name = who(notice.name, household)
    if (notice.told) {
        val how = channelWords(notice.channels)
        return if (how.isEmpty()) "${opening(name)} was told in their notifications list only." else "${opening(name)} was sent $how."
    }
    return when (notice.reason) {
        "not_a_household_notice" -> "No notice went to $name for this."
        "already_notified" -> "${opening(name)} was already told about this."
        "not_requested" -> "No confirmation was sent."
        "dispatch_failed" -> "The notice to $name could not be sent."
        else -> whyNot(notice.reason, name)?.let { "Nobody was told: $it." } ?: "Nobody was told."
    }
}

/** "Done." plus the household line, without a stray space when the line is empty. */
fun withHouseholdLine(sentence: String, line: String): String = if (line.isEmpty()) sentence else "$sentence $line"

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

private fun JsonObject.strings(key: String): List<String>? =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull }

/** A callable's `notice` as a [HouseholdNotice], or null when it carries none. */
fun householdNoticeOf(raw: JsonElement?): HouseholdNotice? {
    val obj = raw as? JsonObject ?: return null
    val told = (obj["told"] as? JsonPrimitive)?.booleanOrNull ?: return null
    return HouseholdNotice(told, obj.str("reason"), obj.str("name"), obj.strings("channels").orEmpty())
}

/** A `previewVisitNotification` answer with a key, or null when it is not one (an older server). */
fun householdPreviewOf(obj: JsonObject): HouseholdNoticePreview.Ready? {
    val willNotify = (obj["willNotify"] as? JsonPrimitive)?.booleanOrNull ?: return null
    val channels = obj.strings("channels") ?: return null
    return HouseholdNoticePreview.Ready(willNotify, obj.str("reason"), obj.str("name"), channels)
}

/**
 * #1841: the line under New visit's "Send the household a confirmation".
 * Null when the control is not offered (a visit recorded as completed), ""
 * until a household is picked, then what the server says it would reach, or
 * that nobody will be told when the control is off.
 */
fun newVisitConfirmationLine(
    offered: Boolean,
    householdPicked: Boolean,
    sendConfirmation: Boolean,
    preview: HouseholdNoticePreview,
    household: String,
): String? {
    if (!offered) return null
    if (!householdPicked) return ""
    if (!sendConfirmation) return "Nobody will be told about this visit."
    return householdNoticeConfirmLine(preview, household).orEmpty()
}
