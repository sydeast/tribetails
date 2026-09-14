package com.kinfolk.portal.auth

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * #886: the portal (Android, web and desktop) reports a credential failure to
 * `recordFailedLogin`, and only a credential failure, without holding up or
 * changing the error the kinfolk sees.
 *
 * The fake's report NEVER returns, and the repository's report scope is
 * `Unconfined`, so the launch reaches the fake inside `signInWithEmailPassword`
 * and suspends there forever. A repository that waited on the report would
 * never get to `assertFailsWith`.
 */
private class FailingSignInBackend(
    private val failure: Throwable,
    private val kind: SignInFailureKind,
    private val reportThrows: Throwable? = null,
) : AuthBackend {
    val reported = mutableListOf<String>()

    override fun classifySignInFailure(t: Throwable): SignInFailureKind = kind

    override suspend fun reportFailedLogin(email: String) {
        reported += email
        reportThrows?.let { throw it }
        awaitCancellation()
    }

    override suspend fun signInWithEmailPassword(email: String, password: String): AuthState.SignedIn = throw failure
    override suspend fun currentUser(): AuthState = AuthState.SignedOut
    override suspend fun signInWithCustomToken(token: String) = AuthState.SignedIn("u", null, null)
    override suspend fun sendMagicLink(email: String) = Unit
    override suspend fun signInWithMagicLink(email: String, link: String) = AuthState.SignedIn("u", email, null)
    override suspend fun signInWithIdToken(provider: AuthProviderId, idToken: String, rawNonce: String?) =
        AuthState.SignedIn("u", null, null)
    override suspend fun signInWithPhoneOtp(verificationId: String, smsCode: String) = AuthState.SignedIn("u", null, null)
    override suspend fun signOut() = Unit
    override suspend fun sendPasswordReset(email: String) = Unit
    override suspend fun changePassword(currentPassword: String, newPassword: String) = Unit
    override suspend fun changeEmail(currentPassword: String, newEmail: String) = Unit
}

class AuthRepositoryFailedLoginTest {

    private fun repoFor(backend: AuthBackend) = AuthRepository(backend, reportScope = CoroutineScope(Dispatchers.Unconfined))

    @Test
    fun credentialFailure_reportsTheTrimmedEmail_andRethrowsTheSameError() = runTest {
        val wrong = RuntimeException("auth/wrong-password")
        val backend = FailingSignInBackend(wrong, SignInFailureKind.Credentials)

        val thrown = assertFailsWith<RuntimeException> { repoFor(backend).signInWithEmailPassword(" pat@household.test ", "guess") }

        assertSame(wrong, thrown)
        assertEquals(listOf("pat@household.test"), backend.reported)
    }

    @Test
    fun otherFailures_areNotReported_andReachTheCallerUnchanged() = runTest {
        for (err in listOf(RuntimeException("network-request-failed"), RuntimeException("too-many-requests"), RuntimeException("user-disabled"))) {
            val backend = FailingSignInBackend(err, SignInFailureKind.Other)
            val thrown = assertFailsWith<RuntimeException> { repoFor(backend).signInWithEmailPassword("pat@household.test", "pw") }
            assertSame(err, thrown)
            assertTrue(backend.reported.isEmpty(), "${err.message} must not be reported")
        }
    }

    @Test
    fun lockedRefusal_becomesAccountLockedException_andIsNotReported() = runTest {
        val refusal = RuntimeException("BLOCKING_FUNCTION_ERROR_RESPONSE : This account is locked.")
        val backend = FailingSignInBackend(refusal, SignInFailureKind.Locked)

        val thrown = assertFailsWith<AccountLockedException> { repoFor(backend).signInWithEmailPassword("pat@household.test", "right") }

        assertEquals(ACCOUNT_LOCKED_MESSAGE, thrown.message)
        assertSame(refusal, thrown.cause)
        assertTrue(backend.reported.isEmpty())
    }

    @Test
    fun aReportThatThrows_isSwallowed_andTheSignInErrorIsStillThrown() = runTest {
        val wrong = RuntimeException("auth/invalid-credential")
        val backend = FailingSignInBackend(wrong, SignInFailureKind.Credentials, reportThrows = IllegalStateException("functions down"))

        val thrown = assertFailsWith<RuntimeException> { repoFor(backend).signInWithEmailPassword("pat@household.test", "guess") }

        assertSame(wrong, thrown)
        assertEquals(listOf("pat@household.test"), backend.reported)
    }

    @Test
    fun theDefaultBackend_reportsNothing_andStillRecognisesTheLockedText() = runTest {
        // A backend that overrides neither hook (the test fakes, a future backend)
        // gets the interface defaults: no report, and locked detection by text.
        val refusal = RuntimeException("This account is locked. Use the reset password link or contact support.")
        val plain = object : AuthBackend by FailingSignInBackend(refusal, SignInFailureKind.Other) {
            override fun classifySignInFailure(t: Throwable): SignInFailureKind = classifySignInFailure(null, t.message)
            override suspend fun reportFailedLogin(email: String) = Unit
        }
        assertFailsWith<AccountLockedException> { repoFor(plain).signInWithEmailPassword("pat@household.test", "right") }
    }
}

class AuthRepositoryReportScopeTest {

    @Test
    fun everyRepository_sharesOneReportScope_soNoneLeavesAnOrphanedJobBehind() {
        val backend = FailingSignInBackend(RuntimeException("x"), SignInFailureKind.Other)
        val first = AuthRepository(backend)
        val second = AuthRepository(backend)
        assertSame(first.reportScopeForTest, second.reportScopeForTest)
        assertSame(sharedAuthReportScope, first.reportScopeForTest)
    }

    @Test
    fun isCredentialFailure_followsTheBackendClassification_andNeverThrows() {
        val cred = AuthRepository(FailingSignInBackend(RuntimeException("x"), SignInFailureKind.Credentials))
        val other = AuthRepository(FailingSignInBackend(RuntimeException("x"), SignInFailureKind.Other))
        assertTrue(cred.isCredentialFailure(RuntimeException("wrong")))
        assertTrue(!other.isCredentialFailure(RuntimeException("net")))
        val throwing = object : AuthBackend by FailingSignInBackend(RuntimeException("x"), SignInFailureKind.Other) {
            override fun classifySignInFailure(t: Throwable): SignInFailureKind = error("classifier broke")
        }
        assertTrue(!AuthRepository(throwing).isCredentialFailure(RuntimeException("x")))
    }
}

class SignInFailureClassifierTest {

    @Test
    fun credentialCodes_inEverySpelling() {
        for (code in listOf(
            "auth/wrong-password", "auth/user-not-found", "auth/invalid-credential", "auth/invalid-login-credentials",
            "ERROR_WRONG_PASSWORD", "ERROR_USER_NOT_FOUND", "ERROR_INVALID_CREDENTIAL",
            "INVALID_PASSWORD", "EMAIL_NOT_FOUND", "INVALID_LOGIN_CREDENTIALS",
        )) {
            assertEquals(SignInFailureKind.Credentials, classifySignInFailure(code, "some message"), code)
        }
    }

    @Test
    fun notCounted_inEverySpelling() {
        for (code in listOf(
            "auth/network-request-failed", "auth/too-many-requests", "auth/user-disabled", "auth/invalid-email",
            "ERROR_USER_DISABLED", "ERROR_INVALID_EMAIL", "ERROR_TOO_MANY_REQUESTS",
            "USER_DISABLED", "TOO_MANY_ATTEMPTS_TRY_LATER", "INVALID_EMAIL", null,
        )) {
            assertEquals(SignInFailureKind.Other, classifySignInFailure(code, "some message"), code.toString())
        }
    }

    @Test
    fun theLockedRefusalWins_whateverTheCode() {
        val body = "BLOCKING_FUNCTION_ERROR_RESPONSE : ((HTTP request to http://127.0.0.1:5699/auntieos-ttpc/us-central1/beforeSignIn " +
            "returned HTTP error 403: {\"error\":{\"message\":\"This account is locked. Use the reset password link or contact support.\"," +
            "\"status\":\"PERMISSION_DENIED\"}}))"
        assertEquals(SignInFailureKind.Locked, classifySignInFailure("auth/internal-error", body))
        assertEquals(SignInFailureKind.Locked, classifySignInFailure("INVALID_LOGIN_CREDENTIALS", body))
        assertTrue(ACCOUNT_LOCKED_MESSAGE.contains("Forgot password?"))
    }
}
