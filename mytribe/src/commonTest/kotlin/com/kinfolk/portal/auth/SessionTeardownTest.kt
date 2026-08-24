package com.kinfolk.portal.auth

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #539 — "clicking the signout does not honor logout. users can click browser
 * back or forward to regain access without logging in again."
 *
 * Reported against the web portal; the Android portal had the same shape, so it
 * gets the same fix and the same proof. What is being held down here is an
 * ORDER: the calls that need a live session go first and are allowed to fail or
 * time out; ending the session is not allowed to do either.
 *
 * The failing case is the interesting one. A `cleanUp` that never returns used
 * to mean `signOut` never ran — leaving a kinfolk who had pressed Sign Out
 * looking at a spinner, still signed in, one app relaunch away from their
 * household.
 */
class SessionTeardownTest {

    @Test
    fun signsOutEvenWhenCleanupNeverReturns() = runTest {
        val neverAnswers = CompletableDeferred<Unit>()
        var signedOut = false

        tearDownSession(
            cleanUp = { neverAnswers.await() },
            signOut = { signedOut = true },
            timeoutMs = 4_000L,
        )

        // runTest's virtual clock skips the four seconds; a real one would not,
        // and four seconds of waiting is the whole price of this guarantee.
        assertTrue(signedOut, "sign-out must not be conditional on the cleanup answering")
    }

    @Test
    fun signsOutEvenWhenCleanupThrows() = runTest {
        var signedOut = false

        tearDownSession(
            cleanUp = { throw IllegalStateException("unregisterFcmToken refused") },
            signOut = { signedOut = true },
        )

        assertTrue(signedOut)
    }

    @Test
    fun runsCleanupFirst_whileTheCallsAreStillAuthorized() = runTest {
        val order = mutableListOf<String>()

        tearDownSession(
            cleanUp = { order += "cleanUp" },
            signOut = { order += "signOut" },
        )

        // Both cleanup calls (push unregister, server-side revoke) need the ID
        // token that signOut is about to discard.
        assertEquals(listOf("cleanUp", "signOut"), order)
    }

    @Test
    fun waitsForACleanupThatAnswersInTime() = runTest {
        val order = mutableListOf<String>()

        tearDownSession(
            cleanUp = { order += "cleanUp" },
            signOut = { order += "signOut" },
            timeoutMs = 4_000L,
        )

        assertEquals(listOf("cleanUp", "signOut"), order)
    }

    @Test
    fun reportsAFailedSignOut_ratherThanSwallowingIt() = runTest {
        var reported: Throwable? = null

        tearDownSession(
            cleanUp = {},
            signOut = { throw IllegalStateException("auth backend down") },
            onFailure = { reported = it },
        )

        // The one case where the kinfolk really is still signed in. Silence here
        // strands them on the spinner the caller has already put up.
        assertEquals("auth backend down", reported?.message)
    }
}
