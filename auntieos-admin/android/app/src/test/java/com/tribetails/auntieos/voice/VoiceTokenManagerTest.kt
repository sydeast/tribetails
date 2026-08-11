package com.tribetails.auntieos.voice

import com.google.firebase.functions.FirebaseFunctionsException
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The first tests this file has ever had, and they exist because of what it used
 * to do when things went wrong: nothing visible.
 *
 * `fetchToken` caught every exception, logged it, returned `null`, and the caller
 * returned early. An operator whose Twilio secrets were unset, or who lacked the
 * admin claim, or who had no network, saw exactly the same thing in all three
 * cases and in the working case too: an app that looked fine and a phone that
 * never rang. Three of the four cases below assert on [VoiceTokenManager.state]
 * for that reason; a test that only checked "did it return a token" would have
 * passed against the broken version too.
 *
 * The fourth is expiry. `cachedToken` was written once on first success and never
 * invalidated, so an hour later the app was handing out a dead token and failing
 * at registration instead of re-minting.
 *
 * Pure JVM: the Voice SDK static and the FCM lookup are both behind seams that
 * [VoiceTokenManager.configure] takes, so nothing here needs Robolectric.
 */
class VoiceTokenManagerTest {

    private lateinit var scope: CoroutineScope

    /** Records what was handed to the Voice SDK, and how many times. */
    private class RecordingRegistrar(
        private val failure: Throwable? = null,
    ) : VoiceRegistrar {
        val registrations = mutableListOf<Pair<String, String>>()

        override fun register(accessToken: String, fcmToken: String, onResult: (Throwable?) -> Unit) {
            registrations += accessToken to fcmToken
            onResult(failure)
        }
    }

    @Before
    fun setUp() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        VoiceTokenManager.resetForTests()
    }

    @After
    fun tearDown() {
        // Cancel first: the near-expiry refresh job lives on this scope and would
        // otherwise outlive the test that started it.
        scope.cancel()
        VoiceTokenManager.resetForTests()
    }

    private fun token(
        value: String = "jwt-1",
        identity: String = "auntie",
        expiresInSeconds: Long = 3600L,
    ) = VoiceAccessToken(token = value, identity = identity, expiresInSeconds = expiresInSeconds)

    private fun configure(
        mint: suspend () -> Result<VoiceAccessToken>,
        registrar: VoiceRegistrar = RecordingRegistrar(),
        fcmToken: String = "fcm-abc",
        now: () -> Long = { 0L },
    ) = VoiceTokenManager.configure(
        mint = mint,
        registrar = registrar,
        fcmTokenProvider = { fcmToken },
        now = now,
        scope = scope,
    )

    @Test
    fun `a successful mint registers the Voice SDK and reports Registered with the identity`() =
        runBlocking {
            val registrar = RecordingRegistrar()
            configure(mint = { Result.success(token()) }, registrar = registrar)

            VoiceTokenManager.mintAndRegister()

            assertEquals(listOf("jwt-1" to "fcm-abc"), registrar.registrations)
            val state = VoiceTokenManager.state.value
            assertTrue("expected Registered, got $state", state is VoiceTokenState.Registered)
            state as VoiceTokenState.Registered
            assertEquals("auntie", state.identity)
            // now() is 0 and the TTL is an hour, so expiry is an hour out. This
            // pins that the client honours the SERVER's TTL rather than assuming one.
            assertEquals(3_600_000L, state.expiresAtMillis)
        }

    @Test
    fun `a failed-precondition names the missing secret instead of failing silently`() =
        runBlocking {
            // The shape mintVoiceAccessToken actually throws when a Twilio secret
            // is unset. The secret NAME is the whole point: it is what turns an
            // unusable phone into a one-line instruction for the operator.
            val refusal = mockk<FirebaseFunctionsException>()
            every { refusal.code } returns FirebaseFunctionsException.Code.FAILED_PRECONDITION
            every { refusal.details } returns
                mapOf("code" to "missing_secret", "secret" to "TWIML_APP_SID")
            every { refusal.message } returns
                "Voice calling is not configured yet: the TWIML_APP_SID secret is not set."
            val registrar = RecordingRegistrar()
            configure(mint = { Result.failure(refusal) }, registrar = registrar)

            VoiceTokenManager.mintAndRegister()

            val state = VoiceTokenManager.state.value
            assertTrue("expected Misconfigured, got $state", state is VoiceTokenState.Misconfigured)
            state as VoiceTokenState.Misconfigured
            assertEquals("TWIML_APP_SID", state.secret)
            assertEquals("missing_secret", state.detailCode)
            assertTrue(state.message.contains("TWIML_APP_SID"))
            // Nothing was registered with a token that was never minted.
            assertTrue(registrar.registrations.isEmpty())
        }

    @Test
    fun `a malformed secret is surfaced the same way, carrying its own detail code`() =
        runBlocking {
            val refusal = mockk<FirebaseFunctionsException>()
            every { refusal.code } returns FirebaseFunctionsException.Code.FAILED_PRECONDITION
            every { refusal.details } returns
                mapOf("code" to "malformed_secret", "secret" to "TWILIO_API_KEY_SID")
            every { refusal.message } returns "TWILIO_API_KEY_SID is not a valid Twilio SK id."
            configure(mint = { Result.failure(refusal) })

            VoiceTokenManager.mintAndRegister()

            val state = VoiceTokenManager.state.value as VoiceTokenState.Misconfigured
            assertEquals("TWILIO_API_KEY_SID", state.secret)
            assertEquals("malformed_secret", state.detailCode)
        }

    @Test
    fun `a generic failure surfaces as Failed, not as silence`() = runBlocking {
        val registrar = RecordingRegistrar()
        configure(
            mint = { Result.failure(RuntimeException("unavailable: mintVoiceAccessToken")) },
            registrar = registrar,
        )

        VoiceTokenManager.mintAndRegister()

        val state = VoiceTokenManager.state.value
        assertTrue("expected Failed, got $state", state is VoiceTokenState.Failed)
        assertTrue((state as VoiceTokenState.Failed).message.contains("unavailable"))
        assertTrue(registrar.registrations.isEmpty())
        // And the manager must not then hand a caller a token it does not have.
        assertNull(VoiceTokenManager.currentAccessToken())
    }

    @Test
    fun `being signed in without the admin claim reads as NotAuthorized, not as a config problem`() =
        runBlocking {
            // Different sentence, different fix. Telling an operator to go set a
            // Twilio secret when the real problem is a missing admin claim sends
            // them at the wrong thing.
            val refusal = mockk<FirebaseFunctionsException>()
            every { refusal.code } returns FirebaseFunctionsException.Code.PERMISSION_DENIED
            every { refusal.details } returns null
            every { refusal.message } returns "Admin claim required."
            configure(mint = { Result.failure(refusal) })

            VoiceTokenManager.mintAndRegister()

            val state = VoiceTokenManager.state.value
            assertTrue("expected NotAuthorized, got $state", state is VoiceTokenState.NotAuthorized)
            assertEquals("Admin claim required.", (state as VoiceTokenState.NotAuthorized).message)
        }

    @Test
    fun `a fresh token is reused, and one near expiry is re-minted`() = runBlocking {
        // THE REGRESSION. Against the old code cachedToken was set once and read
        // forever, so the second call below returned the same hour-old string and
        // Twilio rejected it at registration.
        var mints = 0
        var clock = 0L
        configure(
            mint = {
                mints++
                Result.success(token(value = "jwt-$mints"))
            },
            now = { clock },
        )

        assertEquals("jwt-1", VoiceTokenManager.currentAccessToken())
        assertEquals(1, mints)

        // Half an hour in, the token has 30 minutes left. Nothing to do.
        clock = 1_800_000L
        assertEquals("jwt-1", VoiceTokenManager.currentAccessToken())
        assertEquals(1, mints)

        // 3540s in: 60 seconds of life left, inside the 5 minute refresh skew.
        // A token this close to lapsing is not handed out.
        clock = 3_540_000L
        assertEquals("jwt-2", VoiceTokenManager.currentAccessToken())
        assertEquals(2, mints)
    }

    @Test
    fun `an expired token is re-minted rather than reused after it has lapsed`() = runBlocking {
        var mints = 0
        var clock = 0L
        configure(
            mint = {
                mints++
                Result.success(token(value = "jwt-$mints"))
            },
            now = { clock },
        )

        assertEquals("jwt-1", VoiceTokenManager.currentAccessToken())
        clock = 7_200_000L // two hours: an hour past expiry
        assertEquals("jwt-2", VoiceTokenManager.currentAccessToken())
        assertEquals(2, mints)
    }

    @Test
    fun `an FCM token refresh re-registers with the new token and does not re-mint a fresh one`() =
        runBlocking {
            var mints = 0
            val registrar = RecordingRegistrar()
            configure(
                mint = {
                    mints++
                    Result.success(token(value = "jwt-$mints"))
                },
                registrar = registrar,
            )

            VoiceTokenManager.mintAndRegister()
            VoiceTokenManager.onFcmTokenRefresh("fcm-rotated")

            assertEquals(
                listOf("jwt-1" to "fcm-abc", "jwt-1" to "fcm-rotated"),
                registrar.registrations,
            )
            assertEquals(1, mints)
        }

    @Test
    fun `an FCM token refresh re-mints when the cached token has expired`() = runBlocking {
        // The latent bug in the old onFcmTokenRefresh: `cachedToken ?: fetch`
        // reused whatever was cached without asking whether it was still alive.
        var mints = 0
        var clock = 0L
        val registrar = RecordingRegistrar()
        configure(
            mint = {
                mints++
                Result.success(token(value = "jwt-$mints"))
            },
            registrar = registrar,
            now = { clock },
        )

        VoiceTokenManager.mintAndRegister()
        clock = 7_200_000L
        VoiceTokenManager.onFcmTokenRefresh("fcm-rotated")

        assertEquals(2, mints)
        assertEquals("jwt-2" to "fcm-rotated", registrar.registrations.last())
    }

    @Test
    fun `a blank FCM token is reported, not logged and dropped`() = runBlocking {
        val registrar = RecordingRegistrar()
        configure(mint = { Result.success(token()) }, registrar = registrar, fcmToken = "")

        VoiceTokenManager.mintAndRegister()

        val state = VoiceTokenManager.state.value
        assertTrue("expected Failed, got $state", state is VoiceTokenState.Failed)
        assertTrue((state as VoiceTokenState.Failed).message.contains("push token"))
        assertTrue(registrar.registrations.isEmpty())
    }

    @Test
    fun `a Voice SDK registration error is surfaced, so a minted token is not mistaken for a working phone`() =
        runBlocking {
            val registrar = RecordingRegistrar(failure = RuntimeException("AccessTokenInvalid"))
            configure(mint = { Result.success(token()) }, registrar = registrar)

            VoiceTokenManager.mintAndRegister()

            val state = VoiceTokenManager.state.value
            assertTrue("expected Failed, got $state", state is VoiceTokenState.Failed)
            assertTrue((state as VoiceTokenState.Failed).message.contains("AccessTokenInvalid"))
        }

    @Test
    fun `classifyTokenFailure falls back to Failed for a failed-precondition with no secret named`() {
        // Total, never throwing on a shape it did not expect: a failed-precondition
        // from anywhere else must not be reported as a named misconfiguration.
        val refusal = mockk<FirebaseFunctionsException>()
        every { refusal.code } returns FirebaseFunctionsException.Code.FAILED_PRECONDITION
        every { refusal.details } returns "not a map"
        every { refusal.message } returns "something else went wrong"

        val state = classifyTokenFailure(refusal)

        assertTrue("expected Failed, got $state", state is VoiceTokenState.Failed)
        assertEquals("something else went wrong", (state as VoiceTokenState.Failed).message)
    }

    @Test
    fun `an uninitialized manager says so rather than returning a quiet null`() = runBlocking {
        VoiceTokenManager.resetForTests()

        assertNull(VoiceTokenManager.currentAccessToken())
        val state = VoiceTokenManager.state.value
        assertTrue("expected Failed, got $state", state is VoiceTokenState.Failed)
        assertTrue((state as VoiceTokenState.Failed).message.contains("never initialized"))
    }
}
