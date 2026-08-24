package com.kinfolk.portal.auth

/**
 * The portal's half of #557: recognising that the backend has declared this
 * session over, and remembering why long enough to say so on the sign-in
 * screen.
 *
 * THREE THINGS THAT ALL LOOK LIKE A REFUSED CALL, AND WHY THEY DIFFER
 *
 *  1. NOT SIGNED IN — `unauthenticated` with nothing else attached. The launch
 *     funnel already owns this; reacting here would fight it.
 *  2. TOKEN EXPIRED, OR A REFRESH THAT WILL NOT LAND — never arrives tagged.
 *     An expired token is refused by the Functions runtime before our own
 *     wrapper runs, and a refresh that keeps failing is a network fact that
 *     retrying usually fixes. [AuthState.Unreachable] is the answer to that,
 *     not a sign-out (#494 is explicit that a throw is not a statement about
 *     whether anybody is signed in).
 *  3. SESSION REVOKED, OR ACCOUNT DISABLED — the backend tags these, and no
 *     amount of retrying will ever clear them. The session is over; the only
 *     way forward is to sign in again.
 *
 * Only 3 tears anything down.
 *
 * WHY THIS MATCHES ON TEXT. `functions/src/lib/sessionRevocation.ts` sends the
 * machine-readable reason twice: in `details.reason`, which the web portal
 * reads, and inside the message, for here. The KMP portal reaches Cloud
 * Functions through three different clients (the native Android SDK, gitlive on
 * JS, REST on jvm) whose `details` payloads decode to three different shapes,
 * while the message survives all three intact. The same reasoning already
 * decided `GalleryController.isPermissionDenied`. The tokens are namespaced
 * strings that appear nowhere else, so the match is specific in practice.
 */
enum class SessionEndedReason {
    /** `signOutAllDevices`, a sign-out elsewhere, or a password change. */
    Revoked,

    /** An operator turned the account off. */
    Disabled,
}

internal const val REVOKED_TOKEN = "session-revoked"
internal const val DISABLED_TOKEN = "user-disabled"

/**
 * The reason the backend gave for refusing, or null when this failure is not
 * one it tagged. Walks the cause chain: every client on the way here wraps the
 * original exception at least once.
 */
fun sessionEndedReason(t: Throwable?): SessionEndedReason? {
    var cursor = t
    var depth = 0
    while (cursor != null && depth < 8) {
        val text = "${cursor.message.orEmpty()} ${cursor}"
        when {
            text.contains(DISABLED_TOKEN) -> return SessionEndedReason.Disabled
            text.contains(REVOKED_TOKEN) -> return SessionEndedReason.Revoked
        }
        cursor = cursor.cause
        depth++
    }
    return null
}

/** What the sign-in screen says after an involuntary sign-out. */
fun sessionEndedMessage(reason: SessionEndedReason): String = when (reason) {
    SessionEndedReason.Disabled -> "This account has been turned off. Please contact Auntie."
    SessionEndedReason.Revoked -> "Your session ended, so we signed you out. Please sign in again."
}

/**
 * A one-shot handoff from "the call was refused" to "the sign-in screen
 * explains why".
 *
 * Deliberately a plain singleton and not a parameter threaded through the
 * composition: the refusal happens inside the functions client, several layers
 * below anything holding UI state, and the alternative is a callback passed
 * through every screen for a message that is shown once. [consume] clears as it
 * reads, so the notice cannot reappear on a recomposition or a later visit to
 * the sign-in screen.
 */
object SessionEndedNotice {
    private var pending: String? = null

    fun record(reason: SessionEndedReason) {
        pending = sessionEndedMessage(reason)
    }

    fun consume(): String? {
        val notice = pending
        pending = null
        return notice
    }

    /** Test seam: forget anything recorded. */
    fun clear() {
        pending = null
    }
}
