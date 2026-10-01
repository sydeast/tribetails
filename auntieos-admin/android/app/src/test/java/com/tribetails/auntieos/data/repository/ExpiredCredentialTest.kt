package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseAuthInvalidUserException
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GetTokenResult
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.util.AuntieLog
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkObject
import io.mockk.unmockkObject
import io.mockk.verify
import java.net.UnknownHostException
import java.util.concurrent.ExecutionException
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Issue #1066: a cold start with a cached Firebase user whose credential has been
 * revoked or has expired.
 *
 * Firebase refuses to refresh the token with `FirebaseAuthInvalidUserException`
 * (or `FirebaseAuthInvalidCredentialsException`), and from the operator's side
 * that is the same event as #573's server-tagged revocation: the session is over
 * and the only way forward is the sign-in screen. It is an expected auth state,
 * so it must not reach Sentry as an error, and it must end the local session so
 * `AuntieNavHost` lands on `AdminLoginScreen` with a sentence saying why.
 *
 * The Functions SDK delivers it wrapped: the real Sentry event (AUNTIEOS-ADMIN-1W)
 * is `ExecutionException: 1 out of 2 underlying tasks failed` with the auth
 * exception as its cause, because the callable waits on the auth token and the
 * App Check token together. The wrapped shape is the one tested.
 */
private fun expiredUser() =
    FirebaseAuthInvalidUserException(
        "ERROR_USER_TOKEN_EXPIRED",
        "The user's credential is no longer valid. The user must sign in again.",
    )

private fun disabledUser() =
    FirebaseAuthInvalidUserException("ERROR_USER_DISABLED", "The user account has been disabled.")

private fun invalidCredential() =
    FirebaseAuthInvalidCredentialsException("ERROR_INVALID_CREDENTIAL", "The credential is malformed or has expired.")

private fun wrappedLikeTheFunctionsSdk(cause: Throwable) =
    ExecutionException("com.google.android.gms.tasks.RuntimeExecutionException: 1 out of 2 underlying tasks failed", cause)

class ExpiredCredentialReasonTest {

    @Test
    fun `an expired or revoked user credential ends the session as Revoked`() {
        assertEquals(SessionEndedReason.Revoked, sessionEndedReason(expiredUser()))
    }

    @Test
    fun `an invalid credential ends the session as Revoked`() {
        assertEquals(SessionEndedReason.Revoked, sessionEndedReason(invalidCredential()))
    }

    @Test
    fun `a disabled user reads as Disabled, which says something different`() {
        assertEquals(SessionEndedReason.Disabled, sessionEndedReason(disabledUser()))
    }

    @Test
    fun `the auth exception is found under the Functions SDK ExecutionException wrapper`() {
        assertEquals(
            SessionEndedReason.Revoked,
            sessionEndedReason(wrappedLikeTheFunctionsSdk(expiredUser())),
        )
    }

    @Test
    fun `a wrapped network failure is still not a session end`() {
        assertNull(sessionEndedReason(wrappedLikeTheFunctionsSdk(UnknownHostException("offline"))))
    }

    @Test
    fun `sign-in required and an invalid credential are expected auth states`() {
        assertTrue(isExpectedSignedOutFailure(IllegalStateException(AuthGate.SIGN_IN_REQUIRED)))
        assertTrue(isExpectedSignedOutFailure(wrappedLikeTheFunctionsSdk(expiredUser())))
        assertTrue(isExpectedSignedOutFailure(RuntimeException("wrapped", IllegalStateException(AuthGate.SIGN_IN_REQUIRED))))
    }

    @Test
    fun `a network failure and an ordinary error are not expected auth states`() {
        assertFalse(isExpectedSignedOutFailure(wrappedLikeTheFunctionsSdk(UnknownHostException("offline"))))
        assertFalse(isExpectedSignedOutFailure(IllegalStateException("mintVoiceAccessToken returned no token")))
    }
}

/**
 * The two cold-start paths that meet the dead credential, driven through the real
 * repository: the admin-claim read `AuntieNavHost` runs on the cached user, and
 * the voice mint `VoiceRegistrationCoordinator` starts on the same user.
 */
class ExpiredCredentialColdStartTest {

    private var signOutCount = 0

    @Before
    fun setUp() = runBlocking {
        SessionEndedNotice.clear()
        signOutCount = 0
        RevokedSessionGuard.sharedEndSession = { signOutCount++ }
        RevokedSessionGuard.shared.resetForTest()
        mockkObject(AuntieLog)
    }

    @After
    fun tearDown() {
        unmockkObject(AuntieLog)
        SessionEndedNotice.clear()
        RevokedSessionGuard.sharedEndSession = { endLocalSession() }
    }

    private fun authWithDeadCredential(): FirebaseAuth {
        val user = mockk<FirebaseUser>(relaxed = true)
        every { user.getIdToken(true) } returns Tasks.forException<GetTokenResult>(expiredUser())
        val auth = mockk<FirebaseAuth>(relaxed = true)
        every { auth.currentUser } returns user
        return auth
    }

    @Test
    fun `the admin-claim read on a dead credential signs out, leaves a notice, and reports nothing`() =
        runBlocking {
            val auth = authWithDeadCredential()
            val repo = AuntieRepository(
                n8n = mockk<N8nApi>(),
                authGate = AuthGate { auth },
                authProvider = { auth },
            )

            val result = repo.isCurrentUserAdmin()

            assertTrue(result.isFailure)
            assertEquals(1, signOutCount)
            assertEquals(sessionEndedMessage(SessionEndedReason.Revoked), SessionEndedNotice.consume())
            verify(exactly = 0) { AuntieLog.e(any(), any()) }
            verify(exactly = 0) { AuntieLog.w(any(), any()) }
        }

    @Test
    fun `the test-mode claim read on a dead credential signs out and reports nothing`() = runBlocking {
        val auth = authWithDeadCredential()

        val result = AuthGate { auth }.testMode()

        assertTrue(result.isFailure)
        assertEquals(1, signOutCount)
        verify(exactly = 0) { AuntieLog.e(any(), any()) }
        verify(exactly = 0) { AuntieLog.w(any(), any()) }
    }

    @Test
    fun `a voice mint refused by the dead credential signs out and reports nothing`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call() } returns
            Tasks.forException<HttpsCallableResult>(wrappedLikeTheFunctionsSdk(expiredUser()))
        every { functions.getHttpsCallable("mintVoiceAccessToken") } returns ref
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        val repo = AuntieRepository(n8n = mockk<N8nApi>(), authGate = gate, functionsOverride = functions)

        val result = repo.mintVoiceAccessToken()

        assertTrue(result.isFailure)
        assertEquals(1, signOutCount)
        verify(exactly = 0) { AuntieLog.e(any(), any()) }
    }

    @Test
    fun `a voice mint while signed out reports nothing to Sentry`() = runBlocking {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } throws IllegalStateException(AuthGate.SIGN_IN_REQUIRED)
        val repo = AuntieRepository(n8n = mockk<N8nApi>(), authGate = gate, functionsOverride = mockk())

        val result = repo.mintVoiceAccessToken()

        assertTrue(result.isFailure)
        verify(exactly = 0) { AuntieLog.e(any(), any()) }
        // Signed out is not a session ending: the sign-in screen already owns it.
        assertEquals(0, signOutCount)
    }

    @Test
    fun `an ordinary mint failure is still reported`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf("identity" to "auntie", "expiresInSeconds" to 3600)
        every { ref.call() } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("mintVoiceAccessToken") } returns ref
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        val repo = AuntieRepository(n8n = mockk<N8nApi>(), authGate = gate, functionsOverride = functions)

        repo.mintVoiceAccessToken()

        verify(exactly = 1) { AuntieLog.e(any(), any()) }
    }
}
