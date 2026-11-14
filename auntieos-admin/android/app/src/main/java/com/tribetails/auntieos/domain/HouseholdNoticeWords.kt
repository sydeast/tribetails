package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.contracts.HouseholdNoticeDto

/**
 * #1816, #1838, #2027, #1841: what an admin action tells the household, said
 * truthfully BEFORE it (the confirm) and AFTER it (the message), from the
 * server only.
 *
 * The confirm asks `previewVisitNotification` with the action's notification
 * key (the dispatcher's own dry run: who, how, or why not), and the message
 * reads the `notice` the action's callable returned. A server that predates
 * `notice` returns none, and the message then claims nothing about the
 * household. Web carries the same sentences in
 * `auntieos-admin/src/lib/householdNoticeWords.ts`; keep them word for word.
 */

/** The notices an admin confirm can ask about (server `PREVIEW_NOTICE_KEYS`). */
object HouseholdNoticeKeys {
    const val KINTALE = "kintale.published"
    const val CANCEL = "kincare.booking.cancel"
    const val CHANGED = "kincare.changed"
    const val NOTE = "kincare.note.auntie"
    const val CONFIRM = "kincare.booking.confirm"
}

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

/** Why nobody is (or was) told, as the clause after "Nobody will be told:". An Auntie is never sent to Settings. */
private fun whyNot(reason: String?, name: String, auntie: Boolean): String? = when (reason) {
    "household_has_no_portal_account" -> "$name has no portal account"
    "household_prefs_suppressed" -> "this notice is turned off for $name"
    "household_notices_off" ->
        if (auntie) "the owner has notices to households turned off" else "notices to households are off in Settings"
    "session_has_no_routing_ids" -> "this visit is not linked to a booking"
    else -> null
}

/** The confirm's line, future tense, or null when it should say nothing (the server could not be asked). */
fun householdNoticeConfirmLine(preview: HouseholdNoticePreview, household: String, auntie: Boolean = false): String? =
    when (preview) {
        HouseholdNoticePreview.Checking -> "Checking who will be told."
        HouseholdNoticePreview.Unknown -> null
        is HouseholdNoticePreview.Ready -> {
            val name = who(preview.name, household)
            if (preview.willNotify) {
                val how = channelWords(preview.channels)
                if (how.isEmpty()) "${opening(name)} will see it in their notifications list only."
                else "${opening(name)} will get $how."
            } else if (preview.reason == "not_a_household_notice") {
                "No notice goes to $name for this."
            } else {
                whyNot(preview.reason, name, auntie)?.let { "Nobody will be told: $it." }
            }
        }
    }

/** The message's line, past tense, from what the server did. "" when the server said nothing. */
fun householdNoticeResultLine(notice: HouseholdNoticeDto?, household: String, auntie: Boolean = false): String {
    if (notice == null) return ""
    val name = who(notice.name, household)
    if (notice.told) {
        val how = channelWords(notice.channels)
        return if (how.isEmpty()) "${opening(name)} was told in their notifications list only."
        else "${opening(name)} was sent $how."
    }
    return when (notice.reason) {
        "not_a_household_notice" -> "No notice went to $name for this."
        "already_notified" -> "${opening(name)} was already told about this."
        "not_requested" -> "No confirmation was sent."
        "dispatch_failed" -> "The notice to $name could not be sent."
        else -> whyNot(notice.reason, name, auntie)?.let { "Nobody was told: $it." } ?: "Nobody was told."
    }
}

/** "Done." plus the household line, without a stray space when the line is empty. */
fun withHouseholdLine(sentence: String, line: String): String = if (line.isEmpty()) sentence else "$sentence $line"

/** A callable's `notice` map as a [HouseholdNoticeDto], or null when it carries none. */
fun householdNoticeOf(raw: Any?): HouseholdNoticeDto? {
    val map = raw as? Map<*, *> ?: return null
    val told = map["told"] as? Boolean ?: return null
    return HouseholdNoticeDto(
        told = told,
        reason = (map["reason"] as? String)?.takeIf { it.isNotBlank() },
        name = (map["name"] as? String)?.takeIf { it.isNotBlank() },
        channels = (map["channels"] as? List<*>).orEmpty().mapNotNull { it as? String },
    )
}

/**
 * #1841 (operator ruling 2026-11-12): the line under New Booking's "Send the
 * household a confirmation" control. Null when the control is not offered (a
 * draft, or a visit recorded as completed), "" until a household is picked,
 * then what the server says the confirmation would reach, or that nobody will
 * be told when the control is off.
 */
fun newVisitConfirmationLine(
    confirmNow: Boolean,
    timing: VisitWindowTiming?,
    householdPicked: Boolean,
    sendConfirmation: Boolean,
    preview: HouseholdNoticePreview,
    household: String,
    auntie: Boolean = false,
): String? {
    if (!confirmNow || timing == VisitWindowTiming.ENDED) return null
    if (!householdPicked) return ""
    if (!sendConfirmation) return "Nobody will be told about this visit."
    return householdNoticeConfirmLine(preview, household, auntie).orEmpty()
}
