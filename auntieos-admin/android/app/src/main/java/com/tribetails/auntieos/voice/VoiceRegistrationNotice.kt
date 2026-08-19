package com.tribetails.auntieos.voice

/**
 * What the app shell should say about voice registration, or nothing at all.
 *
 * [title] is the headline, [detail] the sentence underneath. `null` from
 * [voiceRegistrationNotice] means there is nothing to report and no banner is
 * drawn.
 */
data class VoiceRegistrationNotice(
    val title: String,
    val detail: String,
)

/**
 * Turn [VoiceTokenState] into the banner the operator reads, or `null`.
 *
 * Pure, and separate from the composable, so the copy is pinned by a JVM test
 * rather than only by opening the app on a day the phone happens to be broken.
 *
 * WHY A BANNER AT ALL. Every failure below was already classified, and every one
 * of them reached the operator as nothing: `VoiceTokenState` had no production
 * consumer, so a device that could not receive a business call looked exactly
 * like one that could, and the failure existed only as a Sentry breadcrumb
 * nobody was watching (#433). Missed inbound calls are the consequence, which is
 * not something to leave to a log line.
 *
 * The two states that report nothing report nothing on purpose.
 * [VoiceTokenState.Working] is a few seconds of ordinary startup and a banner
 * that flashes on every launch trains people to ignore banners.
 * [VoiceTokenState.Idle] means registration has not been attempted, which for
 * this shell means the sign-in has not finished arriving yet.
 */
fun voiceRegistrationNotice(state: VoiceTokenState): VoiceRegistrationNotice? = when (state) {
    is VoiceTokenState.Registered -> null
    VoiceTokenState.Idle -> null
    VoiceTokenState.Working -> null

    // Names the environment variable the server is missing. That name is the
    // whole value of this branch: it turns "calling is broken" into one thing to
    // go and set.
    is VoiceTokenState.Misconfigured -> VoiceRegistrationNotice(
        title = "Incoming calls are not set up",
        detail = "${state.message} Nobody can reach the business line on this phone " +
            "until ${state.secret} is set on the server.",
    )

    // Signed in, but this account cannot mint a voice token. Different fix from
    // the one above, so a different sentence.
    is VoiceTokenState.NotAuthorized -> VoiceRegistrationNotice(
        title = "This account cannot answer the business line",
        detail = "${state.message} Incoming calls will not reach this phone.",
    )

    // Everything else: no network, the callable is not deployed, Twilio refused
    // the registration, no push token. The retries are already spent by the time
    // this is what [VoiceTokenManager.state] holds.
    is VoiceTokenState.Failed -> VoiceRegistrationNotice(
        title = "Incoming calls are not reaching this phone",
        detail = state.message,
    )
}
