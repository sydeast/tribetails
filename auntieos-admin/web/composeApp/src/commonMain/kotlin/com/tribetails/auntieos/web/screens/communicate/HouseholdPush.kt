package com.tribetails.auntieos.web.screens.communicate

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * #2294: the push an approved Communicate "Push" draft sends to its household,
 * through the `sendHouseholdPush` callable. Before this the console had no Push
 * type: a stored Push draft opened as a KinTale and approving it would have
 * sent a visit report. Same outcomes and the same sentences as the web admin's
 * `api/householdPush.ts` and the phone's `HouseholdPush.kt`.
 */
internal data class HouseholdPushResult(
    /** sent, listed, held, already_sent. */
    val outcome: String,
    /** Why less than a push reached the household, or null. */
    val reason: String?,
)

/** The longest push line `sendHouseholdPush` accepts. */
internal const val PUSH_MAX = 1000

/** Pure: why a Push approve cannot go ahead, or null. Mirrors the phone's `pushApproveBlocker`. */
internal fun pushApproveBlocker(kinfolkId: String?, copy: String): String? {
    if (copy.isBlank()) return "The message is empty. Write something before approving."
    if (kinfolkId.isNullOrBlank()) return "This push is not addressed to a household. Choose one before sending."
    val length = copy.trim().length
    return if (length > PUSH_MAX) "A push can be at most $PUSH_MAX characters. This one is $length." else null
}

private val KNOWN_OUTCOMES = setOf("sent", "listed", "held", "already_sent")

/** Pure: the callable's answer. An answer this console cannot read is never a send. */
internal fun decodeHouseholdPushResult(raw: String?): HouseholdPushResult {
    val obj = runCatching { Json.parseToJsonElement(raw.orEmpty()).jsonObject }.getOrNull()
    val outcome = obj?.get("outcome")?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
        ?.takeIf { it in KNOWN_OUTCOMES } ?: "held"
    val reason = obj?.get("reason")?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
        ?.takeIf { it.isNotBlank() }
    return HouseholdPushResult(outcome, reason)
}

/** What the screen shows under the approve bar. */
internal data class HouseholdPushNotice(
    val title: String,
    val body: String,
    /** True when the push did not go out, or nobody knows yet: it can be tried again. */
    val retryable: Boolean,
    /** #2389: the server refused these words. The draft goes back to unapproved and [body] says why. */
    val needsApproval: Boolean = false,
)
/**
 * #2381: this client's own name for an approved Push draft with no answer on
 * it. Never the server's word, so [decodeHouseholdPushResult] does not take it.
 */
internal const val PUSH_UNANSWERED = "unanswered"
/** #2389: the two refusals `sendHouseholdPush` names in `details.code`. */
internal const val PUSH_WORDS_CHANGED_CODE = "push_words_changed"
internal const val PUSH_IN_FLIGHT_CODE = "push_in_flight"
/**
 * Pure: the notice for a call that failed. Only the two named refusals are
 * known answers. Anything else may be a send that went out and lost its reply,
 * so it never says what did or did not reach the household.
 */
internal fun householdPushCallFailed(code: String?, message: String?): HouseholdPushNotice {
    val said = message?.trim()?.ifBlank { null }
    return when (code) {
        PUSH_WORDS_CHANGED_CODE -> HouseholdPushNotice(
            "Not sent",
            said ?: "The words changed after this draft was approved. Approve it again to send them.",
            retryable = false,
            needsApproval = true,
        )
        PUSH_IN_FLIGHT_CODE -> HouseholdPushNotice(
            "Sending now",
            said ?: "This push is being sent right now. Wait a moment, then try again.",
            retryable = true,
        )
        else -> HouseholdPushNotice(
            "Not confirmed",
            "The draft is approved, but the push was not confirmed: " +
                "${said?.trimEnd('.') ?: "the server did not answer"}. " +
                "Try again. A push that already went out is not sent twice.",
            retryable = true,
        )
    }
}
/**
 * #2381: whether the open draft offers Delete. A draft that reached its
 * household is kept. An approved Push that did not go out, or whose send never
 * answered, keeps its Delete beside Try again.
 */
internal fun canDeleteDraft(hasDraft: Boolean, sent: Boolean, approved: Boolean, notice: HouseholdPushNotice?): Boolean =
    hasDraft && !sent && (!approved || notice?.retryable == true)
/**
 * #2389: an approved Push that has not gone out sends its approved words and
 * no others, so editing them returns the draft to unapproved.
 */
internal fun editReturnsToUnapproved(notice: HouseholdPushNotice?): Boolean = notice?.retryable == true
/**
 * #2389: the notice the screen holds after the draft editor changes from
 * [before] to [after]. Null means the draft reads as unapproved again.
 */
internal fun pushNoticeAfterEdit(notice: HouseholdPushNotice?, before: String, after: String): HouseholdPushNotice? =
    if (before != after && editReturnsToUnapproved(notice)) null else notice
/**
 * #2389: the notice the screen holds after a push attempt answered. Null when
 * the server refused the words: the draft reads as unapproved again and the
 * answer's body is shown as the reason.
 */
internal fun pushNoticeAfterAnswer(answer: HouseholdPushNotice): HouseholdPushNotice? = answer.takeUnless { it.needsApproval }
/** The delete confirm's line. It says "not sent" only when that is known. */
internal fun deleteDraftConfirmLine(notice: HouseholdPushNotice?): String =
    if (notice == null || notice.title == "Not sent") "It has not been sent. Deleting it cannot be undone."
    else "Deleting it cannot be undone."

/** Pure: the result in the operator's words. Only `sent` says a push went out. */
internal fun householdPushNotice(r: HouseholdPushResult, household: String): HouseholdPushNotice = when (r.outcome) {
    "sent" -> HouseholdPushNotice("Push sent", "Sent to $household's phone. It is on their notifications list too.", false)
    "already_sent" -> HouseholdPushNotice("Push sent", "This push already went to $household. Nothing new was sent.", false)
    "listed" -> HouseholdPushNotice(
        "On their notifications list",
        when (r.reason) {
            "household_push_off" ->
                "It is on $household's notifications list. No push went to their phone, because their settings keep pushes for your messages off."
            "no_device" ->
                "It is on $household's notifications list. No push went to a phone, because nobody in the household has turned on pushes in the app yet."
            else -> "It is on $household's notifications list. The push to their phone did not go through."
        },
        false,
    )
    PUSH_UNANSWERED -> HouseholdPushNotice(
        "Not confirmed",
        "The last send did not answer, so it is not known whether this push reached $household. " +
            "Try again. A push that already went out is not sent twice.",
        true,
    )
    else -> HouseholdPushNotice(
        "Not sent",
        when (r.reason) {
            "household_notices_off" ->
                "Nothing reached $household. Notices to households are switched off. Switch on \"Send notices to households\" in Settings, under Notifications, then try again."
            "household_has_no_portal_account" ->
                "Nothing reached $household. Nobody in the household has signed in to the portal yet, so there is no one to send a push to."
            "notice_turned_off" ->
                "Nothing reached $household. Message notices to households are turned off in your notification settings. Turn them on, then try again."
            else -> "Nothing reached $household."
        },
        true,
    )
}

