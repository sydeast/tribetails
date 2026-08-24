package com.kinfolk.portal.attestation

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * Issue #556. The web half of that bug was a readiness guard that could never
 * be false; the Android half was that there was no App Check here at all. Both
 * shipped as a feature that looked present and attested nothing, which is the
 * failure mode these assertions exist to make impossible to repeat: activation
 * is not success, and a failure is never silent.
 */
class AppCheckStateTest {

    @Test
    fun startsInactiveBecauseNothingHasBeenTried() {
        assertEquals(AppCheckStatus.INACTIVE, AppCheckState().status)
        assertFalse(AppCheckState().attested)
    }

    @Test
    fun installingAProviderIsNotAttesting() {
        val state = AppCheckState()

        assertTrue(state.beginActivation())

        // The state the old code had no word for: a provider is installed and
        // no token has been minted. Reporting this as success is how an
        // unattested client passes for an attested one.
        assertEquals(AppCheckStatus.PENDING, state.status)
        assertFalse(state.attested)
    }

    @Test
    fun onlyATokenMakesItActive() {
        val state = AppCheckState()
        state.beginActivation()

        state.attested()

        assertEquals(AppCheckStatus.ACTIVE, state.status)
        assertTrue(state.attested)
    }

    @Test
    fun activationHappensOnceHoweverManyTimesItIsAskedFor() {
        val state = AppCheckState()

        assertTrue(state.beginActivation())
        assertFalse(state.beginActivation())
        assertFalse(state.beginActivation())
    }

    @Test
    fun aFailureIsReportedWithItsCause() {
        var reason: String? = null
        var cause: Throwable? = null
        val boom = IllegalStateException("Play Integrity unavailable")
        val state = AppCheckState { r, e ->
            reason = r
            cause = e
        }
        state.beginActivation()

        state.failed("attestation failed", boom)

        assertEquals(AppCheckStatus.FAILED, state.status)
        assertFalse(state.attested)
        assertEquals("attestation failed", reason)
        assertSame(boom, cause)
    }

    @Test
    fun aFailureIsReportedEvenWithNoThrowableToBlame() {
        var reason: String? = null
        var cause: Throwable? = IllegalStateException("should be overwritten")
        val state = AppCheckState { r, e ->
            reason = r
            cause = e
        }

        state.failed("attestation timed out")

        assertEquals("attestation timed out", reason)
        assertNull(cause)
    }

    @Test
    fun aFailedProcessDoesNotRetryIntoTheSameWall() {
        val state = AppCheckState()
        state.beginActivation()
        state.failed("attestation failed")

        assertFalse(state.beginActivation())
        assertEquals(AppCheckStatus.FAILED, state.status)
    }
}
