package com.kinfolk.portal.auth

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2140: on Android a refused sign-out quietly re-checked the account and put
 * the kinfolk back in their household with nothing said. [SignOutFailure] is
 * the app-level sign-out; these pin that a refusal is both re-resolved AND
 * kept for the screen to say.
 */
class SignOutFailureTest {

    @Test
    fun aRefusedSignOut_isKeptForTheScreen_andTheAccountIsReChecked() = runTest {
        val failure = SignOutFailure()
        var reResolved = 0

        failure.run(
            cleanUp = {},
            signOut = { throw IllegalStateException("auth backend down") },
            reResolve = { reResolved += 1 },
        )

        assertTrue(failure.failed)
        assertEquals(SIGN_OUT_FAILED, failure.message)
        assertEquals(1, reResolved, "the re-check is what takes the kinfolk off the spinner")
    }

    @Test
    fun theMessageIsPlainWords_withNoRawError() = runTest {
        val failure = SignOutFailure()
        failure.run(cleanUp = {}, signOut = { throw IllegalStateException("auth/internal-error: raw detail") }, reResolve = {})

        val message = failure.message!!
        assertTrue(message.contains("still signed in"))
        assertFalse(message.contains("auth/"))
        assertFalse(message.contains("raw detail"))
    }

    @Test
    fun aSignOutThatWorks_saysNothing_andDoesNotReCheck() = runTest {
        val failure = SignOutFailure()
        var reResolved = 0

        failure.run(cleanUp = {}, signOut = {}, reResolve = { reResolved += 1 })

        assertFalse(failure.failed)
        assertNull(failure.message)
        assertEquals(0, reResolved)
    }

    @Test
    fun aFailedCleanUp_isNotASignOutFailure() = runTest {
        // Cleanup is best effort (#539); the sign-out still happened.
        val failure = SignOutFailure()
        failure.run(cleanUp = { throw IllegalStateException("unregister refused") }, signOut = {}, reResolve = {})

        assertNull(failure.message)
    }

    @Test
    fun theNextAttempt_clearsTheOldMessage_whileItRuns() = runTest {
        val failure = SignOutFailure()
        failure.run(cleanUp = {}, signOut = { throw IllegalStateException("down") }, reResolve = {})
        assertTrue(failure.failed)

        val gate = CompletableDeferred<Unit>()
        val job = launch { failure.run(cleanUp = {}, signOut = { gate.await() }, reResolve = {}) }
        testScheduler.runCurrent()
        assertFalse(failure.failed, "a stale failure must not sit over a new attempt")

        gate.complete(Unit)
        job.join()
        assertNull(failure.message)
    }

    @Test
    fun dismiss_clearsTheMessage() = runTest {
        val failure = SignOutFailure()
        failure.run(cleanUp = {}, signOut = { throw IllegalStateException("down") }, reResolve = {})

        failure.dismiss()

        assertNull(failure.message)
    }

    @Test
    fun cancellation_isNotReportedAsAFailure() = runTest {
        val failure = SignOutFailure()
        var reResolved = 0
        val job = launch {
            failure.run(cleanUp = {}, signOut = { throw CancellationException("left") }, reResolve = { reResolved += 1 })
        }
        job.join()

        assertFalse(failure.failed)
        assertEquals(0, reResolved)
    }
}
