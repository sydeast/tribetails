package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
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
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE WIRE, for `AuntieRepository.mintVoiceAccessToken`.
 *
 * `VoiceTokenManagerTest` mocks this method out entirely, so every case there
 * would still pass with the callable name misspelled, with the response decoded
 * wrong, or with an identity invented client-side. Those are the failures only a
 * `FirebaseFunctions`-level test can see, and each of them ships as "the phone
 * does not ring" with no other symptom.
 *
 * The no-payload assertion is a security assertion, not a tidiness one. The
 * endpoint this replaces let the caller be anybody; `mintVoiceAccessToken`
 * derives the identity from the caller's own auth context and reads nothing from
 * `req.data`. If this client ever starts sending an identity, someone has begun
 * reopening that hole from the other end.
 */
class AuntieRepositoryMintVoiceAccessTokenTest {

    private val n8nApi = mockk<N8nApi>()

    private fun passingAuthGate(): AuthGate {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        return gate
    }

    private fun repoWith(functions: FirebaseFunctions, authGate: AuthGate = passingAuthGate()) =
        AuntieRepository(n8n = n8nApi, authGate = authGate, functionsOverride = functions)

    private fun stub(functions: FirebaseFunctions, data: Any?): HttpsCallableReference {
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns data
        every { ref.call() } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("mintVoiceAccessToken") } returns ref
        return ref
    }

    @Test
    fun `it calls mintVoiceAccessToken by name and sends no payload at all`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = stub(
            functions,
            mapOf("token" to "jwt", "identity" to "auntie", "expiresInSeconds" to 3600),
        )

        val result = repoWith(functions).mintVoiceAccessToken()

        assertTrue(result.isSuccess)
        verify(exactly = 1) { functions.getHttpsCallable("mintVoiceAccessToken") }
        verify(exactly = 1) { ref.call() }
        verify(exactly = 0) { ref.call(any()) }
    }

    @Test
    fun `all three fields decode, and expiresInSeconds survives arriving as an Int`() = runBlocking {
        // The callable wire hands 3600 back as a java.lang.Integer, so `as Long`
        // here would ClassCastException on every single mint. That failure would
        // look identical to the old 404: no token, no calls.
        val functions = mockk<FirebaseFunctions>()
        stub(functions, mapOf("token" to "jwt-abc", "identity" to "auntie", "expiresInSeconds" to 3600))

        val minted = repoWith(functions).mintVoiceAccessToken().getOrThrow()

        assertEquals("jwt-abc", minted.token)
        assertEquals("auntie", minted.identity)
        assertEquals(3600L, minted.expiresInSeconds)
    }

    @Test
    fun `a Long expiresInSeconds decodes too`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        stub(functions, mapOf("token" to "jwt", "identity" to "auntie", "expiresInSeconds" to 900L))

        assertEquals(900L, repoWith(functions).mintVoiceAccessToken().getOrThrow().expiresInSeconds)
    }

    @Test
    fun `a response missing a field fails rather than producing a half-built token`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        stub(functions, mapOf("token" to "jwt", "identity" to "auntie"))

        val result = repoWith(functions).mintVoiceAccessToken()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("expiresInSeconds"))
    }

    @Test
    fun `a blank token is refused, because Twilio would only reject it later`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        stub(functions, mapOf("token" to "  ", "identity" to "auntie", "expiresInSeconds" to 3600))

        val result = repoWith(functions).mintVoiceAccessToken()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("token"))
    }

    @Test
    fun `the failed-precondition reaches the caller intact, details and all`() = runBlocking {
        // Load-bearing: the manager reads `details.secret` off this exact object
        // to name the unset secret. Flattening the failure to a message here
        // would leave the banner with nothing specific to say.
        val functions = mockk<FirebaseFunctions>()
        val refusal = mockk<FirebaseFunctionsException>()
        every { refusal.code } returns FirebaseFunctionsException.Code.FAILED_PRECONDITION
        every { refusal.details } returns mapOf("code" to "missing_secret", "secret" to "TWIML_APP_SID")
        every { refusal.message } returns "the TWIML_APP_SID secret is not set"
        val ref = mockk<HttpsCallableReference>()
        every { ref.call() } throws refusal
        every { functions.getHttpsCallable("mintVoiceAccessToken") } returns ref

        val error = repoWith(functions).mintVoiceAccessToken().exceptionOrNull()

        assertTrue("expected the Firebase exception, got $error", error is FirebaseFunctionsException)
        error as FirebaseFunctionsException
        assertEquals(FirebaseFunctionsException.Code.FAILED_PRECONDITION, error.code)
        assertEquals("TWIML_APP_SID", (error.details as Map<*, *>)["secret"])
    }

    @Test
    fun `a signed-out caller never reaches the wire`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } throws IllegalStateException("Not signed in")

        val result = repoWith(functions, gate).mintVoiceAccessToken()

        assertTrue(result.isFailure)
        verify(exactly = 0) { functions.getHttpsCallable(any()) }
    }
}
