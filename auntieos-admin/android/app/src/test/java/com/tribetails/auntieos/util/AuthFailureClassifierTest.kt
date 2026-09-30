package com.tribetails.auntieos.util

import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseAuthInvalidUserException
import com.tribetails.auntieos.data.repository.AuthGate
import com.tribetails.auntieos.data.repository.SignInRequiredException
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import io.mockk.verify
import io.sentry.Sentry
import io.sentry.SentryLevel
import java.io.IOException
import java.util.concurrent.ExecutionException
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #1066 (AUNTIEOS-ADMIN-1W, 1Y): being signed out, or holding a credential
 * Firebase will no longer refresh, is an auth STATE the sign-in screen handles,
 * not a defect. [isExpectedAuthState] is the line, and [AuntieLog] must keep
 * those to a breadcrumb while still reporting everything else.
 */
class AuthFailureClassifierTest {

    private val invalidUser = FirebaseAuthInvalidUserException(
        "ERROR_USER_TOKEN_EXPIRED",
        "The user's credential is no longer valid. The user must sign in again.",
    )

    @Before
    fun setUp() = mockkStatic(Sentry::class)

    @After
    fun tearDown() = unmockkStatic(Sentry::class)

    @Test
    fun `the sign-in gate's refusal is expected, by type and by its sentence`() {
        assertTrue(isExpectedAuthState(SignInRequiredException()))
        assertTrue(isExpectedAuthState(IllegalStateException(AuthGate.SIGN_IN_REQUIRED)))
        assertTrue(isExpectedAuthState(IllegalStateException("wrapped", SignInRequiredException())))
    }

    @Test
    fun `an invalid credential is expected, including inside the SDK's combined task`() {
        assertTrue(isExpectedAuthState(invalidUser))
        assertTrue(isExpectedAuthState(ExecutionException("1 out of 2 underlying tasks failed", invalidUser)))
        assertTrue(
            isExpectedAuthState(FirebaseAuthInvalidCredentialsException("ERROR_INVALID_CREDENTIAL", "stale")),
        )
    }

    @Test
    fun `ordinary failures are not auth states`() {
        assertFalse(isExpectedAuthState(null))
        assertFalse(isExpectedAuthState(IllegalStateException("mintVoiceAccessToken returned no token")))
        assertFalse(isExpectedAuthState(IOException("Unable to resolve host")))
    }

    @Test
    fun `AuntieLog keeps an expected auth state out of Sentry`() {
        AuntieLog.e("Failed to mint a Twilio Voice access token", ExecutionException("1 of 2", invalidUser))
        AuntieLog.e("x", SignInRequiredException())
        verify(exactly = 0) { Sentry.captureException(any<Throwable>()) }
    }

    @Test
    fun `AuntieLog still reports a real defect`() {
        AuntieLog.e("boom", IllegalStateException("a real bug"))
        verify(exactly = 1) { Sentry.captureException(any<Throwable>()) }
        verify(exactly = 0) { Sentry.captureMessage(any<String>(), any<SentryLevel>()) }
    }
}
