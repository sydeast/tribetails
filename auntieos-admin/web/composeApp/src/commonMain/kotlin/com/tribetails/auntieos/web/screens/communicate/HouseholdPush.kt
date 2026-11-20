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
    /** True only when the push was held: it can be tried again once the cause is fixed. */
    val retryable: Boolean,
)

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

/**
 * Pure: the notice for a failed call. The draft is approved; the push may not
 * have gone, so it stays retryable and never reads as a send.
 */
internal fun householdPushCallFailed(message: String?, household: String): HouseholdPushNotice = HouseholdPushNotice(
    "Not sent",
    "The draft is approved, but the push could not be sent: " +
        "${message?.ifBlank { null } ?: "the server did not answer"}. Nothing reached $household.",
    true,
)
