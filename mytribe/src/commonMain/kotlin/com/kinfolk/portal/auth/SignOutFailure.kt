package com.kinfolk.portal.auth

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * What a kinfolk reads when sign-out did not happen (#2140). The same sentence
 * as the web portal's `SIGN_OUT_FAILED` (mytribe/web/src/lib/auth.ts).
 */
const val SIGN_OUT_FAILED: String =
    "We couldn't sign you out. You are still signed in. Check your connection and try again."

/**
 * The app-level sign-out, with its failure kept where the screen can say it.
 *
 * Before #2140 the failure branch of [tearDownSession] only re-checked the
 * account: the kinfolk watched the spinner, landed back in their household and
 * was never told that the sign-out they asked for had not happened. [run] keeps
 * that re-check (it is what takes them off the spinner) and also records the
 * failure, so the shell can show [message] until it is dismissed or the next
 * attempt starts.
 *
 * Plain Kotlin with snapshot state, so `commonTest` (and with it the Android
 * unit-test run) covers the rule without a Compose host.
 */
class SignOutFailure {
    var failed: Boolean by mutableStateOf(false)
        private set

    /** The sentence to show, or null when the last attempt did not fail. */
    val message: String? get() = if (failed) SIGN_OUT_FAILED else null

    suspend fun run(
        cleanUp: suspend () -> Unit,
        signOut: suspend () -> Unit,
        reResolve: suspend () -> Unit,
        timeoutMs: Long = SIGN_OUT_CLEANUP_TIMEOUT_MS,
    ) {
        failed = false
        var refused = false
        tearDownSession(cleanUp = cleanUp, signOut = signOut, onFailure = { refused = true }, timeoutMs = timeoutMs)
        if (refused) {
            failed = true
            reResolve()
        }
    }

    fun dismiss() {
        failed = false
    }
}
