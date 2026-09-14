package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseNetworkException
import com.google.firebase.FirebaseTooManyRequestsException
import com.google.firebase.auth.AuthResult
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseAuthInvalidUserException
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.api.N8nApi
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #886: the Android admin reports a credential failure to `recordFailedLogin`,
 * and only a credential failure, without holding up or changing the error.
 *
 * One mockk `FirebaseAuth` and one mockk `FirebaseFunctions` through the
 * repository's existing seams. The report scope is `Unconfined`, so the launch
 * runs up to its first suspension inside `signInAdmin`, which is what lets a
 * `verify` see the call. The callable's Task NEVER completes: a `signInAdmin`
 * that waited on the report would hit the timeout instead of returning.
 */
class AuntieRepositoryFailedLoginTest {

    private val auth = mockk<FirebaseAuth>(relaxed = true)
    private val functions = mockk<FirebaseFunctions>()
    private val callable = mockk<HttpsCallableReference>()
    private val repo = AuntieRepository(
        n8n = mockk<N8nApi>(),
        authGate = AuthGate { auth },
        functionsOverride = functions,
        authProvider = { auth },
        reportScope = CoroutineScope(Dispatchers.Unconfined),
    )

    private val email = "auntie@tribetails.test"

    init {
        every { functions.getHttpsCallable("recordFailedLogin") } returns callable
        every { callable.call(any()) } returns TaskCompletionSource<HttpsCallableResult>().task
    }

    private fun signInFailsWith(t: Exception) {
        every { auth.signInWithEmailAndPassword(any(), any()) } returns Tasks.forException<AuthResult>(t)
    }

    private fun signIn(): Result<Unit> = runBlocking {
        // Two seconds is far longer than an inline failure takes and far shorter
        // than "waited for a report that never finishes".
        withTimeout(2_000) { repo.signInAdmin("  $email ", "guess") }
    }

    @Test
    fun `every production repository shares one report scope, so a rebuilt one leaves no orphaned job`() {
        val first = AuntieRepository(n8n = mockk<N8nApi>(), authGate = AuthGate { auth }, authProvider = { auth })
        val second = AuntieRepository(n8n = mockk<N8nApi>(), authGate = AuthGate { auth }, authProvider = { auth })
        assertTrue(first.reportScopeForTest === second.reportScopeForTest)
        assertTrue(first.reportScopeForTest === failedLoginReportScope)
    }

    @Test
    fun `a wrong password reports the trimmed email and returns the same error without waiting`() {
        val wrong = FirebaseAuthInvalidCredentialsException("ERROR_WRONG_PASSWORD", "The password is invalid.")
        signInFailsWith(wrong)

        val result = signIn()

        assertTrue(result.isFailure)
        assertEquals("The password is invalid.", result.exceptionOrNull()?.message)
        verify(exactly = 1) { callable.call(mapOf("email" to email)) }
    }

    @Test
    fun `user not found and invalid credential are reported`() {
        for (code in listOf("ERROR_USER_NOT_FOUND", "ERROR_INVALID_CREDENTIAL")) {
            val t: Exception = if (code == "ERROR_USER_NOT_FOUND") {
                FirebaseAuthInvalidUserException(code, "There is no user record.")
            } else {
                FirebaseAuthInvalidCredentialsException(code, "The supplied auth credential is incorrect.")
            }
            assertTrue("$code must count", isCredentialSignInFailure(t))
        }
        signInFailsWith(FirebaseAuthInvalidUserException("ERROR_USER_NOT_FOUND", "There is no user record."))
        signIn()
        verify(exactly = 1) { callable.call(mapOf("email" to email)) }
    }

    @Test
    fun `a network failure is not reported`() {
        signInFailsWith(FirebaseNetworkException("A network error has occurred."))
        val result = signIn()
        assertEquals("A network error has occurred.", result.exceptionOrNull()?.message)
        verify(exactly = 0) { functions.getHttpsCallable(any<String>()) }
    }

    @Test
    fun `too many requests, a disabled user and a malformed email are not reported`() {
        val notCounted = listOf(
            FirebaseTooManyRequestsException("We have blocked all requests from this device."),
            FirebaseAuthInvalidUserException("ERROR_USER_DISABLED", "The user account has been disabled."),
            FirebaseAuthInvalidCredentialsException("ERROR_INVALID_EMAIL", "The email address is badly formatted."),
        )
        for (t in notCounted) {
            assertFalse("${t.message} must not count", isCredentialSignInFailure(t))
            signInFailsWith(t)
            signIn()
        }
        verify(exactly = 0) { functions.getHttpsCallable(any<String>()) }
    }

    @Test
    fun `the beforeSignIn refusal is shown as the locked message and is not reported`() {
        val locked = FirebaseAuthException(
            "ERROR_INTERNAL_ERROR",
            "An internal error has occurred. [ BLOCKING_FUNCTION_ERROR_RESPONSE:((HTTP request to " +
                "https://example.test/beforeSignIn returned HTTP error 403: {\"error\":{\"message\":" +
                "\"This account is locked. Use the reset password link or contact support.\"," +
                "\"status\":\"PERMISSION_DENIED\"}})) ]",
        )
        signInFailsWith(locked)

        val result = signIn()

        assertEquals(ACCOUNT_LOCKED_MSG, result.exceptionOrNull()?.message)
        assertTrue(ACCOUNT_LOCKED_MSG.contains("Forgot password?"))
        verify(exactly = 0) { functions.getHttpsCallable(any<String>()) }
    }

    @Test
    fun `a report that fails is swallowed and the sign-in error is unchanged`() {
        every { callable.call(any()) } returns Tasks.forException(IllegalStateException("functions unavailable"))
        signInFailsWith(FirebaseAuthInvalidCredentialsException("ERROR_INVALID_CREDENTIAL", "The supplied auth credential is incorrect."))

        val result = signIn()

        assertEquals("The supplied auth credential is incorrect.", result.exceptionOrNull()?.message)
        verify(exactly = 1) { callable.call(mapOf("email" to email)) }
    }
}
