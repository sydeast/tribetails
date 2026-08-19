package com.tribetails.auntieos.voice

import com.tribetails.auntieos.data.repository.AuthGate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The tests for the defect in issue #433, driven from the signal the fix hangs off.
 *
 * WHAT WAS BROKEN. Voice registration was attempted exactly once, from
 * `AuntieOSApp.onCreate`. `Application.onCreate` is the first code in the
 * process, and `mintVoiceAccessToken` opens with `authGate.ensureAuthenticated()`,
 * so on the first launch after an install and on every launch after a sign-out
 * the mint was refused before anybody could possibly be signed in. A refused mint
 * scheduled no retry (the re-mint timer is set by a mint that SUCCEEDED) and
 * nothing else ever called back in: `refresh()` and `currentAccessToken()` had no
 * callers anywhere in the app, and the remaining entry point fires only when FCM
 * rotates the device token, weeks apart. The operator signed in a second later,
 * the app looked entirely normal, and inbound business calls did not reach the
 * phone for the rest of that process.
 *
 * WHAT THESE ASSERT. That the trigger is the sign-in rather than process start,
 * which is the whole shape of the fix, and that the three paths that matter all
 * end with a registration: signing in for the first time, signing out and back
 * in, and a mint that was refused before the sign-in arrived.
 *
 * Pure JVM. The coordinator takes the auth state as a `Flow<String?>` of UIDs,
 * in production `AuntieRepository.authStateFlow()` mapped to its uid, so nothing
 * here needs Firebase or Robolectric, and the flow is driven by hand.
 */
class VoiceRegistrationCoordinatorTest {

    private lateinit var scope: CoroutineScope
    private lateinit var coordinator: VoiceRegistrationCoordinator

    /** The UID of the signed-in admin, or null for signed out. Drives everything. */
    private val sessionUids = MutableStateFlow<String?>(null)

    private val backoffs = mutableListOf<Long>()

    private class RecordingRegistrar : VoiceRegistrar {
        val registrations = mutableListOf<Pair<String, String>>()

        override fun register(accessToken: String, fcmToken: String, onResult: (Throwable?) -> Unit) {
            registrations += accessToken to fcmToken
            onResult(null)
        }
    }

    private lateinit var registrar: RecordingRegistrar

    @Before
    fun setUp() {
        // Unconfined so an emission into `sessionUids` runs the collector, and
        // the mint it starts, on this thread before `value =` returns. The
        // alternative is asserting after a sleep, and a timing test for a race
        // is just another flake.
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        sessionUids.value = null
        backoffs.clear()
        registrar = RecordingRegistrar()
        coordinator = VoiceRegistrationCoordinator()
        VoiceTokenManager.resetForTests()
    }

    @After
    fun tearDown() {
        // Both, in this order. `VoiceTokenManager` is a process-wide `object` and
        // the whole unit-test suite is one JVM, so a collector or a near-expiry
        // job left running here would go on writing into another
        // test's state, which is exactly the pollution issue #425 was about.
        coordinator.stop()
        scope.cancel()
        VoiceTokenManager.resetForTests()
    }

    /** Configures the manager with test seams and a mint that counts its calls. */
    private fun configureVoice(mint: suspend (Int) -> Result<VoiceAccessToken>): () -> Int {
        var mints = 0
        VoiceTokenManager.configure(
            mint = { mints++; mint(mints) },
            registrar = registrar,
            fcmTokenProvider = { "fcm-abc" },
            now = { 0L },
            scope = scope,
            backoff = { backoffs += it },
        )
        return { mints }
    }

    private fun token(value: String) =
        VoiceAccessToken(token = value, identity = "auntie", expiresInSeconds = 3600L)

    @Test
    fun `a first launch with nobody signed in registers nothing, and says nothing`() {
        val mints = configureVoice { Result.success(token("jwt-$it")) }

        coordinator.start(scope, sessionUids)

        // THE REPORTED DEFECT, from the other side. Startup no longer mints, so
        // there is no refusal to park on. Idle is the true statement: registration
        // has not been attempted, and there is nothing to tell the operator about.
        assertEquals(0, mints())
        assertTrue(registrar.registrations.isEmpty())
        assertEquals(VoiceTokenState.Idle, VoiceTokenManager.state.value)
        assertTrue(
            "a signed-out app has nothing to report",
            voiceRegistrationNotice(VoiceTokenManager.state.value) == null,
        )
    }

    @Test
    fun `signing in on a first launch registers this device for inbound calls`() {
        val mints = configureVoice { Result.success(token("jwt-$it")) }
        coordinator.start(scope, sessionUids)

        sessionUids.value = "admin-1"

        assertEquals(1, mints())
        assertEquals(listOf("jwt-1" to "fcm-abc"), registrar.registrations)
        assertTrue(VoiceTokenManager.state.value is VoiceTokenState.Registered)
    }

    @Test
    fun `a mint refused before sign-in is recovered by the sign-in that follows`() {
        // The reported sequence exactly: something asks for a token while nobody
        // is signed in, is refused, and the operator then signs in. Against the
        // old code the refusal was terminal and the phone stayed unregistered.
        var signedIn = false
        val mints = configureVoice {
            if (!signedIn) Result.failure(IllegalStateException(AuthGate.SIGN_IN_REQUIRED))
            else Result.success(token("jwt-$it"))
        }
        coordinator.start(scope, sessionUids)
        runBlocking { VoiceTokenManager.mintAndRegister() }
        assertTrue(VoiceTokenManager.state.value is VoiceTokenState.NotAuthorized)

        signedIn = true
        sessionUids.value = "admin-1"

        assertEquals(2, mints())
        assertEquals(listOf("jwt-2" to "fcm-abc"), registrar.registrations)
        assertTrue(VoiceTokenManager.state.value is VoiceTokenState.Registered)
    }

    @Test
    fun `signing out and back in registers again, with a token minted for the new session`() {
        val mints = configureVoice { Result.success(token("jwt-$it")) }
        coordinator.start(scope, sessionUids)

        sessionUids.value = "admin-1"
        sessionUids.value = null
        sessionUids.value = "admin-1"

        // Two mints, not one. A cached token belongs to the session that minted
        // it; reusing it would register this phone against a signed-out identity.
        assertEquals(2, mints())
        assertEquals(
            listOf("jwt-1" to "fcm-abc", "jwt-2" to "fcm-abc"),
            registrar.registrations,
        )
        assertTrue(VoiceTokenManager.state.value is VoiceTokenState.Registered)
    }

    @Test
    fun `switching straight from one admin to another re-registers for the new one`() {
        // Keyed on the UID rather than on a signed-in boolean, so an account
        // switch that never reports an intermediate signed-out state still
        // re-mints. A boolean cannot tell this apart from a redundant emission.
        val mints = configureVoice { Result.success(token("jwt-$it")) }
        coordinator.start(scope, sessionUids)

        sessionUids.value = "admin-1"
        sessionUids.value = "admin-2"

        assertEquals(2, mints())
        assertEquals(listOf("jwt-1" to "fcm-abc", "jwt-2" to "fcm-abc"), registrar.registrations)
    }

    @Test
    fun `the same session emitted again does not re-mint`() {
        // `authStateFlow` replays its current value on collection and Firebase
        // fires the listener on token refreshes too, so repeats are normal. A
        // mint costs a Twilio call; one per session is the right number.
        val mints = configureVoice { Result.success(token("jwt-$it")) }
        coordinator.start(scope, sessionUids)

        sessionUids.value = "admin-1"
        sessionUids.value = "admin-1"
        sessionUids.value = "admin-1"

        assertEquals(1, mints())
        assertEquals(listOf("jwt-1" to "fcm-abc"), registrar.registrations)
    }

    @Test
    fun `a transient refusal at sign-in is retried and the device ends up registered`() {
        // The retry lives in the manager, but it has to survive being reached
        // through the coordinator, which is how it is reached in production.
        var attempts = 0
        val mints = configureVoice {
            attempts++
            if (attempts < 3) Result.failure(RuntimeException("unavailable: mintVoiceAccessToken"))
            else Result.success(token("jwt-$it"))
        }
        coordinator.start(scope, sessionUids)

        sessionUids.value = "admin-1"

        assertEquals(3, mints())
        assertEquals(listOf(2_000L, 10_000L), backoffs)
        assertEquals(listOf("jwt-3" to "fcm-abc"), registrar.registrations)
        assertTrue(VoiceTokenManager.state.value is VoiceTokenState.Registered)
    }

    @Test
    fun `a stopped coordinator leaves no collector behind to write into the next test`() {
        // The hazard #425 closed, restated for the collector this change adds:
        // one long-lived coroutine holding a reference to a process-wide `object`
        // is enough to corrupt an unrelated test that runs later in the same JVM.
        val mints = configureVoice { Result.success(token("jwt-$it")) }
        coordinator.start(scope, sessionUids)
        sessionUids.value = "admin-1"
        assertEquals(1, mints())
        assertTrue(coordinator.isRunning)

        coordinator.stop()
        assertFalse(coordinator.isRunning)

        sessionUids.value = null
        sessionUids.value = "admin-2"

        // Nothing moved. The stopped collector is not merely idle, it is gone.
        assertEquals(1, mints())
        assertEquals(listOf("jwt-1" to "fcm-abc"), registrar.registrations)
    }

    @Test
    fun `starting twice leaves one collector rather than two racing ones`() {
        val mints = configureVoice { Result.success(token("jwt-$it")) }

        coordinator.start(scope, sessionUids)
        coordinator.start(scope, sessionUids)
        sessionUids.value = "admin-1"

        assertEquals(1, mints())
        assertEquals(listOf("jwt-1" to "fcm-abc"), registrar.registrations)
    }

    @Test
    fun `cancelling the scope stops the coordinator, so an app scope teardown is enough`() {
        val mints = configureVoice { Result.success(token("jwt-$it")) }
        coordinator.start(scope, sessionUids)
        sessionUids.value = "admin-1"
        assertEquals(1, mints())

        scope.cancel()
        sessionUids.value = null
        sessionUids.value = "admin-2"

        assertFalse(coordinator.isRunning)
        assertEquals(1, mints())
    }
}
