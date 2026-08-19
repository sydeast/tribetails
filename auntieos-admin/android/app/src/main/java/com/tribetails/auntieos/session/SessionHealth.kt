package com.tribetails.auntieos.session

import com.google.firebase.FirebaseNetworkException
import java.io.IOException

/**
 * Whether this signed-in session can still mint a Firebase ID token.
 *
 * WHY THIS EXISTS (#454). The 2026-08-17 admin walk captured 19 POSTs to
 * `securetoken.googleapis.com/v1/token`, the Firebase Auth refresh endpoint.
 * Thirteen returned 200; six failed with `Failed to fetch` inside one
 * ~13-second window, and the seventh attempt succeeded. The walk was of the
 * WEB admin, and the cause was that machine briefly losing the network (the
 * same walk shows ten identical failures against Firestore). What the walk did
 * not contain is any sign that either app noticed: nothing was listening.
 *
 * This app had the same blind spot, through its own auth path. Nothing in it
 * registers an `IdTokenListener`, and `AuntieRepository.authStateFlow()` is an
 * `AuthStateListener`, which fires on sign-in, sign-out and user change but NOT
 * on a failed token refresh. Every `getIdToken(...)` call site swallows its
 * failure into that one operation's `Result.failure` plus a log line
 * (`AuthGate.testMode`, `AuntieRepository.currentAdminIdToken`, the two Bearer
 * headers in `generate` and `sendMessage`). So a session whose token cannot be
 * renewed keeps `currentUser` non-null, keeps the whole app believing it is
 * signed in, and turns into a run of unrelated-looking failures with nothing
 * naming the cause.
 */
sealed interface SessionHealth {

    /** The session can mint a token, or has no reason to doubt it. */
    data object Ok : SessionHealth

    /**
     * A refresh is due and the network refused it.
     *
     * Self-clearing. The walk's own shape is six refusals then a success, so
     * this retries on a widening gap rather than sending anyone to the sign-in
     * screen over a few seconds of bad signal. [failures] counts the refusals
     * in this episode, starting at 1.
     */
    data class Unreachable(val failures: Int) : SessionHealth

    /** A refresh failed for a reason retrying cannot fix. Only a re-auth will. */
    data object Expired : SessionHealth
}

/** How often a healthy session re-checks. */
const val SESSION_PROBE_INTERVAL_MILLIS = 60_000L

/** First retry gap after a refused probe. */
const val SESSION_RETRY_MIN_MILLIS = 5_000L

/** Ceiling on the retry gap, so a long outage settles at one probe a minute. */
const val SESSION_RETRY_MAX_MILLIS = 60_000L

/**
 * Which of the two degraded states a failed `getIdToken` means.
 *
 * Only a genuine transport failure is worth retrying. `FirebaseNetworkException`
 * is what the Android SDK raises when the request could not be made at all, and
 * a bare [IOException] is included because the same condition reaches callers
 * unwrapped often enough that treating it as "sign in again" would send an
 * operator to the sign-in screen over a dropped connection.
 *
 * Everything else — an invalid or revoked session, a disabled account, an
 * internal error — is not something waiting fixes.
 */
fun isRetryableRefreshFailure(error: Throwable): Boolean {
    var cause: Throwable? = error
    var hops = 0
    while (cause != null && hops < 8) {
        if (cause is FirebaseNetworkException || cause is IOException) return true
        cause = cause.cause
        hops += 1
    }
    return false
}

/** Exponential backoff, 5s doubling to a 60s ceiling. [failures] starts at 1. */
fun sessionRetryDelayMillis(failures: Int): Long {
    val n = failures.coerceAtLeast(1).coerceAtMost(20)
    val grown = SESSION_RETRY_MIN_MILLIS shl (n - 1)
    return if (grown <= 0L) SESSION_RETRY_MAX_MILLIS else minOf(grown, SESSION_RETRY_MAX_MILLIS)
}

/**
 * What the app shell should say about the session, or nothing at all.
 *
 * [title] is the headline, [detail] the sentence underneath. [reauth] is true
 * when the only way out is to sign in again, which is what puts a button on the
 * banner. Mirrors the web admin's `sessionNotice` in
 * `auntieos-admin/src/components/SessionBanner.tsx` one for one.
 */
data class SessionNotice(
    val title: String,
    val detail: String,
    val reauth: Boolean,
)

/**
 * Turn [SessionHealth] into the banner the operator reads, or `null`.
 *
 * Pure, and separate from the composable, so the copy is pinned by a JVM test
 * rather than only by opening the app on a day the network happens to be bad.
 * Same reasoning as `voiceRegistrationNotice`, and the same shape.
 */
fun sessionHealthNotice(health: SessionHealth): SessionNotice? = when (health) {
    SessionHealth.Ok -> null

    is SessionHealth.Unreachable -> SessionNotice(
        title = "Signed in, but out of touch",
        detail = "This session's sign-in token is due for renewal and the network is " +
            "refusing it. Trying again. Until one goes through, saves and uploads may " +
            "be turned down.",
        reauth = false,
    )

    SessionHealth.Expired -> SessionNotice(
        title = "Sign in again to keep working",
        detail = "This session can no longer renew its sign-in, so anything you do from " +
            "here will be refused. Signing in again fixes it.",
        reauth = true,
    )
}
