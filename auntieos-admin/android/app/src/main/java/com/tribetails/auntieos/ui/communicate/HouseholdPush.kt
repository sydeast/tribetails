package com.tribetails.auntieos.ui.communicate

/**
 * #2061: the push an approved Communicate "Push" draft sends to its household,
 * through the `sendHouseholdPush` callable. The server applies the household
 * send gate and the household's own settings; this file decodes its answer
 * and words it. Same outcomes and the same sentences as the web admin's
 * `api/householdPush.ts`.
 *
 * Before #2061 approving a Push draft said "This type sends nothing from here"
 * and nothing anywhere sent it.
 */
data class HouseholdPushResult(
    /** sent, listed, held, already_sent. */
    val outcome: String,
    /** Why less than a push reached the household, or null. */
    val reason: String?,
)

/** Whether [commType] is the Push copy format, which approving now sends. */
internal fun isPushType(commType: String): Boolean = commType == "push"

/** The longest push line `sendHouseholdPush` accepts. */
internal const val PUSH_MAX = 1000

/** Pure: why a Push approve cannot go ahead, or null. Mirrors the web admin's `approveBlocker`. */
internal fun pushApproveBlocker(commType: String, kinfolkId: String?, copy: String): String? {
    if (!isPushType(commType)) return null
    if (kinfolkId.isNullOrBlank()) return "This push is not addressed to a household. Choose one before sending."
    val length = copy.trim().length
    return if (length > PUSH_MAX) "A push can be at most $PUSH_MAX characters. This one is $length." else null
}

/** Pure: the callable's answer. An answer this client cannot read is never a send. */
internal fun decodeHouseholdPushResult(raw: Map<String, Any?>?): HouseholdPushResult {
    val outcome = (raw?.get("outcome") as? String)?.takeIf { it in setOf("sent", "listed", "held", "already_sent") } ?: "held"
    return HouseholdPushResult(outcome = outcome, reason = raw?.get("reason") as? String)
}

/** What the screen shows under the approve bar. */
data class HouseholdPushNotice(
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
