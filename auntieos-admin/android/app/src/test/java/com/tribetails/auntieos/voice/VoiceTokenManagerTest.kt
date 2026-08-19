package com.tribetails.auntieos.voice

import com.google.firebase.functions.FirebaseFunctionsException
import android.content.Context
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.AuthGate
import io.mockk.coEvery
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

    /**
     * Every retry backoff the manager asked for, in order, in milliseconds.
     *
     * The seam matters as much as the recording. Without it, the four attempts a
     * transient mint failure now makes would sleep for their real forty-odd
     * seconds inside a unit test, and a suite that slow stops being run.
     */
    private val backoffs = mutableListOf<Long>()

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

    /** A registrar that dies before it ever reaches its listener. */
    private class ThrowingRegistrar(private val thrown: Throwable) : VoiceRegistrar {
        override fun register(accessToken: String, fcmToken: String, onResult: (Throwable?) -> Unit) {
            throw thrown
        }
    }

    @Before
    fun setUp() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        backoffs.clear()
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
        backoff = { backoffs += it },
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

    // ── every exit leaves the flow saying something true ────────────────────
    //
    // The bug these pin: `currentAccessToken` set `Working` before minting, and
    // ONLY the registration callback ever moved the flow off it. A caller that
    // got a perfectly good token therefore left the screen on a spinner that
    // would never resolve, reporting "still trying" about work that had already
    // finished. A silent null and a permanent spinner are the same defect.

    @Test
    fun `currentAccessToken re-minting a stale token lands on Registered, never stuck on Working`() =
        runBlocking {
            // THE REGRESSION TEST. Fails against the previous commit with
            // Working, because the re-mint takes the branch that used to set it
            // and no registration follows to clear it.
            var mints = 0
            var clock = 0L
            configure(
                mint = {
                    mints++
                    Result.success(token(value = "jwt-$mints"))
                },
                now = { clock },
            )
            VoiceTokenManager.mintAndRegister()
            assertTrue(VoiceTokenManager.state.value is VoiceTokenState.Registered)

            // Inside the 5 minute skew, so this read re-mints, and it registers
            // nothing.
            clock = 3_540_000L
            assertEquals("jwt-2", VoiceTokenManager.currentAccessToken())
            assertEquals(2, mints)

            val state = VoiceTokenManager.state.value
            assertTrue("expected Registered, got $state", state is VoiceTokenState.Registered)
            state as VoiceTokenState.Registered
            assertEquals("auntie", state.identity)
            // And carrying the NEW expiry, an hour past the re-mint. A stale
            // expiry here would have the UI counting down to a lapse that has
            // already been dealt with.
            assertEquals(3_540_000L + 3_600_000L, state.expiresAtMillis)
        }

    @Test
    fun `currentAccessToken serving a cached token leaves Registered exactly as it was`() =
        runBlocking {
            var mints = 0
            configure(
                mint = {
                    mints++
                    Result.success(token(value = "jwt-$mints"))
                },
            )
            VoiceTokenManager.mintAndRegister()

            assertEquals("jwt-1", VoiceTokenManager.currentAccessToken())

            assertEquals(1, mints)
            assertEquals(
                VoiceTokenState.Registered("auntie", 3_600_000L),
                VoiceTokenManager.state.value,
            )
        }

    @Test
    fun `currentAccessToken does not repaint a registration failure as success`() = runBlocking {
        // The other half of "say something true". Minting works here; what
        // failed is the SDK registration, so the device still will not ring, and
        // a token read must not overwrite that sentence with Registered.
        val registrar = RecordingRegistrar(failure = RuntimeException("AccessTokenInvalid"))
        configure(mint = { Result.success(token()) }, registrar = registrar)
        VoiceTokenManager.mintAndRegister()
        assertTrue(VoiceTokenManager.state.value is VoiceTokenState.Failed)

        assertEquals("jwt-1", VoiceTokenManager.currentAccessToken())

        val state = VoiceTokenManager.state.value
        assertTrue("expected the failure to stand, got $state", state is VoiceTokenState.Failed)
        assertTrue((state as VoiceTokenState.Failed).message.contains("AccessTokenInvalid"))
    }

    @Test
    fun `currentAccessToken before any registration leaves Idle rather than claiming Registered`() =
        runBlocking {
            // Minting a token registers nothing, so "registration has not been
            // attempted" is still the true statement. Not Working, and not a
            // Registered this device has not earned.
            configure(mint = { Result.success(token()) })

            assertEquals("jwt-1", VoiceTokenManager.currentAccessToken())

            assertEquals(VoiceTokenState.Idle, VoiceTokenManager.state.value)
        }

    @Test
    fun `refresh ends on Registered, not on Working`() = runBlocking {
        val registrar = RecordingRegistrar()
        configure(mint = { Result.success(token()) }, registrar = registrar)

        VoiceTokenManager.refresh()

        assertEquals(listOf("jwt-1" to "fcm-abc"), registrar.registrations)
        assertTrue(VoiceTokenManager.state.value is VoiceTokenState.Registered)
    }

    @Test
    fun `refresh ends on a terminal failure when the mint is refused`() = runBlocking {
        configure(mint = { Result.failure(RuntimeException("unavailable")) })

        VoiceTokenManager.refresh()

        val state = VoiceTokenManager.state.value
        assertTrue("expected Failed, got $state", state is VoiceTokenState.Failed)
    }

    @Test
    fun `onFcmTokenRefresh ends on Registered, not on Working`() = runBlocking {
        val registrar = RecordingRegistrar()
        configure(mint = { Result.success(token()) }, registrar = registrar)
        VoiceTokenManager.mintAndRegister()

        VoiceTokenManager.onFcmTokenRefresh("fcm-rotated")

        val state = VoiceTokenManager.state.value
        assertTrue("expected Registered, got $state", state is VoiceTokenState.Registered)
    }

    @Test
    fun `onFcmTokenRefresh ends on a terminal failure when the mint is refused`() = runBlocking {
        configure(mint = { Result.failure(RuntimeException("unavailable")) })

        VoiceTokenManager.onFcmTokenRefresh("fcm-rotated")

        val state = VoiceTokenManager.state.value
        assertTrue("expected Failed, got $state", state is VoiceTokenState.Failed)
    }

    @Test
    fun `onFcmTokenRefresh with a blank token says so instead of registering nothing`() =
        runBlocking {
            val registrar = RecordingRegistrar()
            configure(mint = { Result.success(token()) }, registrar = registrar)

            VoiceTokenManager.onFcmTokenRefresh("   ")

            val state = VoiceTokenManager.state.value
            assertTrue("expected Failed, got $state", state is VoiceTokenState.Failed)
            assertTrue((state as VoiceTokenState.Failed).message.contains("blank token"))
            assertTrue(registrar.registrations.isEmpty())
        }

    @Test
    fun `a registrar that throws before reporting leaves Failed, not a permanent Working`() =
        runBlocking {
            // `Voice.register` is a third-party static. If it throws on the way
            // in, its listener never fires, and without the guard the flow would
            // sit on Working for the life of the process.
            configure(
                mint = { Result.success(token()) },
                registrar = ThrowingRegistrar(IllegalStateException("Voice SDK not initialized")),
            )

            VoiceTokenManager.mintAndRegister()

            val state = VoiceTokenManager.state.value
            assertTrue("expected Failed, got $state", state is VoiceTokenState.Failed)
            assertTrue((state as VoiceTokenState.Failed).message.contains("Voice SDK not initialized"))
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

    // ── #433: a failed mint is not the end of it ────────────────────────────
    //
    // What these pin: registration used to be attempted exactly once, from
    // `Application.onCreate`, before anybody could be signed in. The mint was
    // refused, the manager parked on a terminal state, and nothing ever asked
    // again, because the re-mint timer is scheduled only by a mint that WORKED.
    // The operator signed in a second later, the app looked completely normal,
    // and the phone did not ring for inbound business calls for the rest of that
    // process. So a failure has to do one of two things now: retry itself, or be
    // recoverable by the sign-in that fixes it.
    @Test
    fun `a transient mint failure is retried with backoff and then succeeds`() = runBlocking {
        // Two refusals of the kind that clear on their own (no network, callable
        // briefly unavailable), then a server that answers.
        var mints = 0
        val registrar = RecordingRegistrar()
        configure(
            mint = {
                mints++
                if (mints < 3) Result.failure(RuntimeException("unavailable: mintVoiceAccessToken"))
                else Result.success(token(value = "jwt-$mints"))
            },
            registrar = registrar,
        )
        VoiceTokenManager.mintAndRegister()
        assertEquals(3, mints)
        // Growing waits, so a server that is briefly down is not asked three
        // times in the same second.
        assertEquals(listOf(2_000L, 10_000L), backoffs)
        assertEquals(listOf("jwt-3" to "fcm-abc"), registrar.registrations)
        val state = VoiceTokenManager.state.value
        assertTrue("expected Registered, got $state", state is VoiceTokenState.Registered)
    }
    @Test
    fun `the retry budget is bounded at four attempts and the last failure is what stands`() =
        runBlocking {
            // The other half of "do not be terminal": do not spin either. A mint
            // costs a Twilio call, and a loop with no bound would keep making it
            // for the life of the process.
            var mints = 0
            configure(mint = {
                mints++
                Result.failure(RuntimeException("unavailable: mintVoiceAccessToken"))
            })
            VoiceTokenManager.mintAndRegister()
            assertEquals(4, mints)
            assertEquals(listOf(2_000L, 10_000L, 30_000L), backoffs)
            // And the operator is left with the classified failure, never with a
            // Working that no longer has anything working behind it.
            val state = VoiceTokenManager.state.value
            assertTrue("expected Failed, got $state", state is VoiceTokenState.Failed)
            assertTrue((state as VoiceTokenState.Failed).message.contains("unavailable"))
        }
    @Test
    fun `a mint refused because nobody is signed in reads as NotAuthorized, not as a generic failure`() =
        runBlocking {
            // The exact throw from `AuthGate.ensureAuthenticated`, which is the
            // first line of `mintVoiceAccessToken`. Before #433 this was
            // classified as Failed, which is both the wrong sentence for the
            // operator and the wrong recovery: Failed is the retryable bucket.
            configure(mint = { Result.failure(IllegalStateException(AuthGate.SIGN_IN_REQUIRED)) })
            VoiceTokenManager.mintAndRegister()
            val state = VoiceTokenManager.state.value
            assertTrue("expected NotAuthorized, got $state", state is VoiceTokenState.NotAuthorized)
            assertEquals(
                AuthGate.SIGN_IN_REQUIRED,
                (state as VoiceTokenState.NotAuthorized).message,
            )
        }
    @Test
    fun `an auth failure spends no retries, because signing in is what fixes it`() = runBlocking {
        var mints = 0
        configure(mint = {
            mints++
            Result.failure(IllegalStateException(AuthGate.SIGN_IN_REQUIRED))
        })
        VoiceTokenManager.mintAndRegister()
        // One attempt, no waiting. Asking the same signed-out question three more
        // times over forty seconds gets the same answer three more times, and the
        // event that changes it is the operator signing in.
        assertEquals(1, mints)
        assertTrue("expected no backoff, got $backoffs", backoffs.isEmpty())
    }
    @Test
    fun `a missing Twilio secret spends no retries either, because it will still be missing`() =
        runBlocking {
            val refusal = mockk<FirebaseFunctionsException>()
            every { refusal.code } returns FirebaseFunctionsException.Code.FAILED_PRECONDITION
            every { refusal.details } returns
                mapOf("code" to "missing_secret", "secret" to "TWIML_APP_SID")
            every { refusal.message } returns "the TWIML_APP_SID secret is not set."
            var mints = 0
            configure(mint = { mints++; Result.failure(refusal) })
            VoiceTokenManager.mintAndRegister()
            assertEquals(1, mints)
            assertTrue(backoffs.isEmpty())
            assertTrue(VoiceTokenManager.state.value is VoiceTokenState.Misconfigured)
        }
    @Test
    fun `signing in after a refused mint registers, with its own full retry budget`() = runBlocking {
        // The reported defect end to end, at the manager level. The first mint is
        // the one app startup used to make: refused, because nobody is signed in
        // yet. Then the operator signs in, and the SECOND mint has to happen at
        // all - which is the thing that never used to.
        var signedIn = false
        var mints = 0
        val registrar = RecordingRegistrar()
        configure(
            mint = {
                mints++
                if (!signedIn) Result.failure(IllegalStateException(AuthGate.SIGN_IN_REQUIRED))
                else Result.success(token(value = "jwt-$mints"))
            },
            registrar = registrar,
        )
        VoiceTokenManager.mintAndRegister()
        assertTrue(VoiceTokenManager.state.value is VoiceTokenState.NotAuthorized)
        assertTrue(registrar.registrations.isEmpty())
        signedIn = true
        VoiceTokenManager.onAdminSignedIn()
        assertEquals(2, mints)
        assertEquals(listOf("jwt-2" to "fcm-abc"), registrar.registrations)
        assertTrue(VoiceTokenManager.state.value is VoiceTokenState.Registered)
    }
    @Test
    fun `signing out drops the cached token so the next admin does not inherit it`() = runBlocking {
        // A token carries the identity it was minted for. Reusing the outgoing
        // admin's token registers this phone as the wrong person, which is the
        // same complaint - the call does not arrive - with a subtler cause.
        var mints = 0
        val registrar = RecordingRegistrar()
        configure(
            mint = {
                mints++
                Result.success(token(value = "jwt-$mints"))
            },
            registrar = registrar,
        )
        VoiceTokenManager.onAdminSignedIn()
        assertEquals(1, mints)
        VoiceTokenManager.onSignedOut()
        // Idle, not a failure: a signed-out app has not attempted a registration,
        // and a red banner about a phone that cannot ring is noise on a login screen.
        assertEquals(VoiceTokenState.Idle, VoiceTokenManager.state.value)
        VoiceTokenManager.onAdminSignedIn()
        assertEquals(2, mints)
        assertEquals(
            listOf("jwt-1" to "fcm-abc", "jwt-2" to "fcm-abc"),
            registrar.registrations,
        )
        assertTrue(VoiceTokenManager.state.value is VoiceTokenState.Registered)
    }
    @Test
    fun `an admin sign-in before the manager is initialized is ignored, not crashed`() {
        VoiceTokenManager.resetForTests()
        VoiceTokenManager.onAdminSignedIn()
        assertEquals(VoiceTokenState.Idle, VoiceTokenManager.state.value)
    }

    @Test
    fun `initialize hands over the seams and mints nothing, because nobody is signed in yet`() {
        // THE REGRESSION GUARD FOR #433. `initialize` used to end with
        // `scope.launch { mintAndRegister() }`, and its only caller is
        // `AuntieOSApp.onCreate`, the first code in the process, minutes before
        // any admin signs in. That mint was refused by the callable's own auth
        // gate, and a refused mint schedules no retry, so the phone stopped
        // ringing for the whole session. Anything that puts a mint back here
        // brings the defect back with it.
        val context = mockk<Context>(relaxed = true)
        every { context.applicationContext } returns context
        val repository = mockk<AuntieRepository>()
        var mints = 0
        coEvery { repository.mintVoiceAccessToken() } coAnswers {
            mints++
            Result.success(token())
        }
        VoiceTokenManager.initialize(context, repository, scope)
        assertEquals(0, mints)
        assertEquals(VoiceTokenState.Idle, VoiceTokenManager.state.value)
        // Configured, though: the sign-in that follows has everything it needs.
        VoiceTokenManager.onAdminSignedIn()
        assertEquals(1, mints)
    }
}
