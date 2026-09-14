package com.tribetails.auntieos.web.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * #886: the desktop console reports a credential failure to `recordFailedLogin`,
 * only a credential failure, and returns the same Failure without waiting.
 *
 * The reporter NEVER returns and the report scope is `Unconfined`, so the report
 * reaches the fake inside `signIn` and suspends there. A `signIn` that awaited it
 * would hit the timeout.
 */
class AuthClientFailedLoginTest {

    private val reported = mutableListOf<String>()

    private fun clientFailingWith(code: String, reporterThrows: Boolean = false) = AuthClient(
        signInImpl = { _, _ -> SignInResult.Failure(code) },
        failedLoginReporter = { email ->
            reported += email
            if (reporterThrows) throw IllegalStateException("callable 500")
            awaitCancellation()
        },
        reportScope = CoroutineScope(Dispatchers.Unconfined),
    )

    private fun signIn(client: AuthClient): SignInResult = runBlocking {
        withTimeout(2_000) { client.signIn("  auntie@tribetails.test ", "guess") }
    }

    @Test
    fun credentialFailures_areReportedWithTheTrimmedEmail_andReturnedUnchanged() {
        for (code in listOf("auth/wrong-password", "auth/user-not-found", "auth/invalid-credential")) {
            reported.clear()
            val result = signIn(clientFailingWith(code))
            assertEquals(SignInResult.Failure(code), result)
            assertEquals(listOf("auntie@tribetails.test"), reported, code)
        }
    }

    @Test
    fun networkTooManyDisabledMalformedAndLocked_areNotReported() {
        for (code in listOf(
            "auth/network-request-failed",
            "auth/too-many-requests",
            "auth/user-disabled",
            "auth/invalid-email",
            ACCOUNT_LOCKED_CODE,
        )) {
            val result = signIn(clientFailingWith(code))
            assertEquals(SignInResult.Failure(code), result)
        }
        assertTrue(reported.isEmpty(), "reported: $reported")
    }

    @Test
    fun aReportThatThrows_isSwallowed() {
        val result = signIn(clientFailingWith("auth/invalid-credential", reporterThrows = true))
        assertEquals(SignInResult.Failure("auth/invalid-credential"), result)
        assertEquals(listOf("auntie@tribetails.test"), reported)
    }

    @Test
    fun aSuccessfulSignIn_reportsNothing() {
        val ok = SignInResult.Ok(AuthUser("uid-1", "auntie@tribetails.test"))
        val client = AuthClient(
            signInImpl = { _, _ -> ok },
            failedLoginReporter = { reported += it },
            reportScope = CoroutineScope(Dispatchers.Unconfined),
        )
        assertSame(ok, signIn(client))
        assertTrue(reported.isEmpty())
    }

    @Test
    fun theLockedRefusalBody_mapsToTheLockedCode_andTheLockedCopyNamesTheResetControl() {
        val lockedBody = """{"error":{"code":400,"message":"BLOCKING_FUNCTION_ERROR_RESPONSE : ((HTTP request to http://127.0.0.1:5699/auntieos-ttpc/us-central1/beforeSignIn returned HTTP error 403: {\"error\":{\"message\":\"This account is locked. Use the reset password link or contact support.\",\"status\":\"PERMISSION_DENIED\"}}))","errors":[{"reason":"invalid","domain":"global"}]}}"""
        assertEquals(ACCOUNT_LOCKED_CODE, mapIdentityToolkitError(lockedBody))
        assertEquals(ACCOUNT_LOCKED_MSG, SignInResult.Failure(ACCOUNT_LOCKED_CODE).friendly)
        assertTrue(ACCOUNT_LOCKED_MSG.contains("Forgot password?"))
    }

    @Test
    fun theCredentialBodies_stillMapAsBefore() {
        fun body(m: String) = """{"error":{"code":400,"message":"$m"}}"""
        assertEquals("auth/invalid-credential", mapIdentityToolkitError(body("INVALID_LOGIN_CREDENTIALS")))
        assertEquals("auth/wrong-password", mapIdentityToolkitError(body("INVALID_PASSWORD")))
        assertEquals("auth/user-not-found", mapIdentityToolkitError(body("EMAIL_NOT_FOUND")))
        assertEquals("auth/user-disabled", mapIdentityToolkitError(body("USER_DISABLED")))
        assertEquals("auth/too-many-requests", mapIdentityToolkitError(body("TOO_MANY_ATTEMPTS_TRY_LATER : Access blocked")))
        // The ordinary failure copy the operator already sees is unchanged.
        assertEquals("Email or password didn't match.", SignInResult.Failure("auth/invalid-credential").friendly)
    }
}
