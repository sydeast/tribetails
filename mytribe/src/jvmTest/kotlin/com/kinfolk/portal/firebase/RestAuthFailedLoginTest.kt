package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.AccountLockedException
import com.kinfolk.portal.auth.AuthRepository
import com.kinfolk.portal.auth.SignInFailureKind
import com.kinfolk.portal.auth.platformAuthErrorCode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #886: the portal desktop client signs in over Identity Toolkit REST, so its
 * failures are HTTP bodies. These pin how those bodies classify and that a
 * credential failure reaches the reporter with the email.
 */
class RestAuthFailedLoginTest {

    private fun restFailure(message: String) =
        FirebaseRestException("signIn", 400, """{"error":{"code":400,"message":"$message","errors":[]}}""")

    private val lockedBody =
        """{"error":{"code":400,"message":"BLOCKING_FUNCTION_ERROR_RESPONSE : ((HTTP request to http://127.0.0.1:5699/auntieos-ttpc/us-central1/beforeSignIn returned HTTP error 403: {\"error\":{\"message\":\"This account is locked. Use the reset password link or contact support.\",\"status\":\"PERMISSION_DENIED\"}}))"}}"""

    @Test
    fun readsTheRestErrorCode() {
        assertEquals("INVALID_LOGIN_CREDENTIALS", platformAuthErrorCode(restFailure("INVALID_LOGIN_CREDENTIALS")))
        assertEquals("TOO_MANY_ATTEMPTS_TRY_LATER", platformAuthErrorCode(restFailure("TOO_MANY_ATTEMPTS_TRY_LATER : Access blocked")))
        assertNull(platformAuthErrorCode(IOException("connection reset")))
    }

    @Test
    fun classifiesEachRestFailure() {
        val backend = RestAuthBackend(failedLoginReporter = {})
        for (code in listOf("INVALID_LOGIN_CREDENTIALS", "INVALID_PASSWORD", "EMAIL_NOT_FOUND")) {
            assertEquals(SignInFailureKind.Credentials, backend.classifySignInFailure(restFailure(code)), code)
        }
        for (code in listOf("USER_DISABLED", "TOO_MANY_ATTEMPTS_TRY_LATER", "INVALID_EMAIL")) {
            assertEquals(SignInFailureKind.Other, backend.classifySignInFailure(restFailure(code)), code)
        }
        assertEquals(SignInFailureKind.Other, backend.classifySignInFailure(IOException("connection reset")))
        assertEquals(
            SignInFailureKind.Locked,
            backend.classifySignInFailure(FirebaseRestException("signIn", 400, lockedBody)),
        )
    }

    @Test
    fun aCredentialFailure_reachesTheReporterWithTheEmail_andALockedOneBecomesAccountLocked() = runBlocking {
        val reported = mutableListOf<String>()
        val backend = object : com.kinfolk.portal.auth.AuthBackend by RestAuthBackend(failedLoginReporter = { reported += it }) {
            var next: Throwable = restFailure("INVALID_LOGIN_CREDENTIALS")
            override suspend fun signInWithEmailPassword(email: String, password: String) = throw next
        }
        val repo = AuthRepository(backend, reportScope = CoroutineScope(Dispatchers.Unconfined))

        val wrong = assertFailsWith<FirebaseRestException> { repo.signInWithEmailPassword("pat@household.test", "guess") }
        assertTrue(wrong.responseBody.contains("INVALID_LOGIN_CREDENTIALS"))
        assertEquals(listOf("pat@household.test"), reported)

        backend.next = FirebaseRestException("signIn", 400, lockedBody)
        assertFailsWith<AccountLockedException> { repo.signInWithEmailPassword("pat@household.test", "right") }
        assertEquals(listOf("pat@household.test"), reported, "the locked refusal is not reported")

        backend.next = IOException("connection reset")
        assertFailsWith<IOException> { repo.signInWithEmailPassword("pat@household.test", "pw") }
        assertEquals(1, reported.size, "a network failure is not reported")
    }
}
