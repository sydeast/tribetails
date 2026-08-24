package com.kinfolk.portal.auth

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.withTimeoutOrNull

/**
 * How long sign-out waits on the calls that have to happen while the session is
 * still valid, before it stops waiting and ends the session anyway.
 *
 * Four seconds, matching the web portal's `SIGN_OUT_CLEANUP_TIMEOUT_MS`. Both
 * calls in the prelude are ordinary callables and neither is worth more than a
 * moment of a kinfolk's patience. What the number must NOT be is "however long
 * they take" — see [tearDownSession].
 */
const val SIGN_OUT_CLEANUP_TIMEOUT_MS: Long = 4_000L

/**
 * End the session, in the one order that is safe (#539).
 *
 * THE DEFECT THIS EXISTS FOR. Sign-out has two calls that must go out while the
 * ID token is still valid — unregistering this device's push token, and revoking
 * the account's refresh tokens server-side — and the obvious way to write that
 * is to await them and then sign out. The web portal did exactly that, and it
 * meant a stalled callable or a dropped connection left the kinfolk signed IN,
 * on a device they believed they had left, with nothing on screen to say so.
 * The Android portal had the same shape: `pushCoordinator.onSignOut()` awaited
 * without a clock, and `repo.signOut()` underneath it.
 *
 * So [cleanUp] is best effort with a deadline and [signOut] is not conditional
 * on it. A kinfolk on a borrowed phone with no signal still gets out of their
 * account; the server-side revoke is what they lose, and losing it is strictly
 * better than losing the sign-out.
 *
 * [onFailure] is only for [signOut] itself refusing, which is the one case where
 * the kinfolk really is still signed in and the UI must say so rather than sit
 * on a spinner.
 *
 * Pure of any Compose or Firebase type on purpose: it is the ORDER that is the
 * fix, and an order is worth testing on its own.
 */
suspend fun tearDownSession(
    cleanUp: suspend () -> Unit,
    signOut: suspend () -> Unit,
    onFailure: (Throwable) -> Unit = {},
    timeoutMs: Long = SIGN_OUT_CLEANUP_TIMEOUT_MS,
) {
    withTimeoutOrNull(timeoutMs) {
        try {
            cleanUp()
        } catch (c: CancellationException) {
            // The deadline, arriving. Rethrowing is what lets withTimeoutOrNull
            // recognise its own cancellation — swallow it here and the timeout
            // stops working while still LOOKING like it works.
            throw c
        } catch (t: Throwable) {
            println("[Auth] sign-out cleanup failed (ignored): ${t.message}")
        }
    }

    try {
        signOut()
    } catch (c: CancellationException) {
        throw c
    } catch (t: Throwable) {
        println("[Auth] signOut THREW ${t::class.simpleName}: ${t.message}")
        onFailure(t)
    }
}
