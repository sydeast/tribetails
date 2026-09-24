package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.ActionCodeSettings
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.api.N8nApi
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android admin sends password resets through our own `requestPasswordReset`
 * callable, so the email uses the operator's template instead of Firebase's
 * stock one.
 *
 * Only `{ email }` goes up. #892's continue URL (back to the admin sign-in, not
 * the kinfolk portal) is now the server's to pick, from the account's staff
 * claim, so this pins that the client sends no URL at all and never falls back
 * to `sendPasswordResetEmail`.
 *
 * Same topology as [AuntieRepositoryFailedLoginTest]: mockk `FirebaseAuth` and
 * `FirebaseFunctions` through the repository's seams, completed Tasks so
 * `await()` resolves inline on the JVM.
 */
class AuntieRepositoryPasswordResetTest {

    private val auth = mockk<FirebaseAuth>(relaxed = true)
    private val functions = mockk<FirebaseFunctions>()
    private val callable = mockk<HttpsCallableReference>()
    private val repo = AuntieRepository(
        n8n = mockk<N8nApi>(),
        authGate = AuthGate { auth },
        functionsOverride = functions,
        authProvider = { auth },
    )

    init {
        every { functions.getHttpsCallable("requestPasswordReset") } returns callable
        every { callable.call(any()) } returns Tasks.forResult(mockk<HttpsCallableResult>(relaxed = true))
    }

    private fun refusedWith(code: FirebaseFunctionsException.Code): FirebaseFunctionsException {
        val e = mockk<FirebaseFunctionsException>(relaxed = true)
        every { e.code } returns code
        every { e.message } returns "server said ${code.name}"
        return e
    }

    @Test
    fun `reset asks our callable with the trimmed address and nothing else`() {
        val result = runBlocking { repo.sendPasswordReset("  ops@tribetails.com ") }

        assertTrue(result.isSuccess)
        verify(exactly = 1) { functions.getHttpsCallable("requestPasswordReset") }
        verify(exactly = 1) { callable.call(mapOf("email" to "ops@tribetails.com")) }
    }

    @Test
    fun `reset never falls back to Firebase's own reset email`() {
        runBlocking { repo.sendPasswordReset("ops@tribetails.com") }

        verify(exactly = 0) { auth.sendPasswordResetEmail(any()) }
        verify(exactly = 0) { auth.sendPasswordResetEmail(any(), any<ActionCodeSettings>()) }
    }

    @Test
    fun `a blank email never reaches the callable`() {
        val result = runBlocking { repo.sendPasswordReset("   ") }

        assertTrue(result.isFailure)
        verify(exactly = 0) { functions.getHttpsCallable(any<String>()) }
    }

    @Test
    fun `the per-IP limit reads as the existing too-many-attempts sentence`() {
        val refused = refusedWith(FirebaseFunctionsException.Code.RESOURCE_EXHAUSTED)
        every { callable.call(any()) } returns Tasks.forException(refused)

        val result = runBlocking { repo.sendPasswordReset("ops@tribetails.com") }

        assertEquals("Too many attempts. Wait a minute and try again.", result.exceptionOrNull()?.message)
        assertSame(refused, result.exceptionOrNull()?.cause)
    }

    @Test
    fun `callable refusals map to operator sentences, and anything else keeps the server's message`() {
        assertEquals(RESET_TOO_MANY_MSG, passwordResetFailureMessage(FirebaseFunctionsException.Code.RESOURCE_EXHAUSTED))
        assertEquals(RESET_INVALID_EMAIL_MSG, passwordResetFailureMessage(FirebaseFunctionsException.Code.INVALID_ARGUMENT))
        assertEquals(RESET_NETWORK_MSG, passwordResetFailureMessage(FirebaseFunctionsException.Code.UNAVAILABLE))
        assertEquals(RESET_NETWORK_MSG, passwordResetFailureMessage(FirebaseFunctionsException.Code.DEADLINE_EXCEEDED))
        assertNull(passwordResetFailureMessage(FirebaseFunctionsException.Code.INTERNAL))

        val internal = refusedWith(FirebaseFunctionsException.Code.INTERNAL)
        assertSame(internal, passwordResetFailure(internal))
    }
}
