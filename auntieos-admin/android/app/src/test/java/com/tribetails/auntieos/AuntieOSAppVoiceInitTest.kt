package com.tribetails.auntieos

import com.tribetails.auntieos.voice.VoiceTokenManager
import com.tribetails.auntieos.voice.VoiceTokenState
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Pins the one thing that made a clean tree produce a red Android suite (#425).
 *
 * `VoiceTokenManager` is a process-wide `object` and the unit-test suite is a
 * single JVM, but the leak was never a missing `resetForTests` — both test
 * classes that touch the manager already reset it in `@Before` and `@After`.
 * The writer arrived AFTER those resets: `AuntieOSApp.onCreate` used to call
 * `VoiceTokenManager.initialize`, which launches `mintAndRegister` on the
 * application's `appScope` (Dispatchers.Default) and is never cancelled.
 * Robolectric builds a fresh AuntieOSApp for every test method across all of the
 * Robolectric classes in the suite, so the run accumulated background coroutines
 * that each went on to write `Working` and then a `Failed(...)` into the shared
 * manager, landing wherever the scheduler happened to put them. That is how
 * `a_rotated_token_before_voice_was_initialized_is_ignored_not_crashed` came to
 * read `expected:<Idle> but was:<Failed(...)>` while the class passed alone.
 *
 * The assertion below is deliberately a synchronous probe rather than a wait on
 * the flow. Watching `state` for a stray write would be a timing test, and a
 * timing test for a race is just another flake. Instead this asks the manager a
 * question only an ARMED manager can answer differently: `currentAccessToken`
 * calls the configured `mint` if there is one, and reports the specific "never
 * initialized" sentence if there is not. Before the fix the mint seam was live
 * and the sentence came back from Firebase instead, so this fails deterministically
 * against the defect and passes deterministically against the fix.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AuntieOSAppVoiceInitTest {

    @After
    fun tearDown() {
        // Only an @After. There is deliberately no @Before reset: this test
        // asserts on the state AuntieOSApp.onCreate left behind, and resetting
        // first would erase the exact thing under test.
        VoiceTokenManager.resetForTests()
    }

    @Test
    fun creating_the_application_does_not_arm_the_shared_voice_token_manager() = runBlocking {
        // Robolectric has already constructed AuntieOSApp and run onCreate by
        // the time a test body executes; this just names what we are asserting about.
        assertTrue(
            "expected the real AuntieOSApp under Robolectric",
            RuntimeEnvironment.getApplication() is AuntieOSApp,
        )

        assertNull(
            "app startup must not leave a live mint seam behind in the shared manager",
            VoiceTokenManager.currentAccessToken(),
        )
        assertEquals(
            "app startup armed VoiceTokenManager, so a background mintAndRegister on the " +
                "never-cancelled appScope is free to overwrite another test's state",
            VoiceTokenState.Failed("Voice calling was never initialized on this device."),
            VoiceTokenManager.state.value,
        )
    }
}
