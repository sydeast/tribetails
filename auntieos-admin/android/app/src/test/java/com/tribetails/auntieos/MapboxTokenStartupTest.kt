package com.tribetails.auntieos
import com.tribetails.auntieos.config.MapboxConfig
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
 * Pins the defect this change fixes: nothing ever gave the Maps SDK a token.
 *
 * `LiveTrackingScreen` and `RouteViewerScreen` both build real `MapView`s, but
 * `MapboxOptions.accessToken` had never been set anywhere in this repository's
 * Android history, so every tile request the SDK made was unauthenticated and
 * both screens have been blank since they were written. Unfinished wiring, not
 * a regression: the 2026-07-25 security fix removed a compiled-in geocoding key
 * that these screens never read.
 *
 * **Why this asserts on a recording rather than on `MapboxOptions.accessToken`.**
 * The obvious test - set it, read it back - cannot run here. Touching
 * `MapboxOptions` under Robolectric throws `UnsatisfiedLinkError`, because the
 * property is backed by the SDK's native settings service and there is no
 * native library in a JVM unit test. That was measured, not assumed. So
 * `MapboxConfig` records what startup did with the token and this asserts on the
 * record; `MapboxConfigTest` covers the handover itself against a fake sink.
 *
 * **Why the expectation is derived from `BuildConfig` instead of demanding a
 * non-blank token.** A machine with no token configured still has to produce a
 * green suite: the CI rollback is deleting the `CI_RUNNER` variable, which lands
 * these jobs back on a token-less GitHub runner, and a `isNotBlank()` assertion
 * would turn that into a red suite for a reason that has nothing to do with the
 * code. What is under test is that startup routes whatever the build carries
 * into the SDK, which is exactly what never happened before.
 *
 * "Before any map is constructed" is Android's own guarantee rather than
 * something this test arranges: `Application.onCreate` runs before any Activity
 * or Composable exists, so a token applied there is applied before the first
 * `MapView(context)` call is reachable.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MapboxTokenStartupTest {
    // No @Before reset: this asserts on state AuntieOSApp.onCreate left behind,
    // and resetting first would erase the thing under test. The @After exists
    // because the recording and the sink are process-wide in a single-JVM suite.
    @After
    fun tearDown() {
        MapboxConfig.resetForTests()
    }
    @Test
    fun creating_the_application_hands_the_build_token_to_the_maps_sdk() {
        assertTrue(
            "expected the real AuntieOSApp under Robolectric",
            RuntimeEnvironment.getApplication() is AuntieOSApp,
        )
        val recorded = MapboxConfig.startupTokenApplication
        val configured = BuildConfig.MAPBOX_PUBLIC_TOKEN
        if (configured.isBlank()) {
            // A build with no token still has to have ASKED. NeverConsulted here
            // is the original defect, and it is what this branch catches.
            assertEquals(
                "startup must consult MAPBOX_PUBLIC_TOKEN even when the build has none",
                MapboxConfig.TokenApplication.NoTokenConfigured,
                recorded,
            )
        } else {
            assertTrue(
                "startup must hand MAPBOX_PUBLIC_TOKEN to the SDK, was $recorded",
                recorded is MapboxConfig.TokenApplication.Delivered,
            )
            assertEquals(
                "the token handed over must be the one this build was configured with",
                configured,
                (recorded as MapboxConfig.TokenApplication.Delivered).token,
            )
        }
    }
    @Test
    fun the_token_is_never_a_literal_in_source() {
        // MapboxConfig held a live key until 2026-07-25 and must not hold one
        // again: the token arrives as a gradle property, never as source.
        val literalToken = MapboxConfig::class.java.declaredFields.firstOrNull { field ->
            field.type == String::class.java &&
                runCatching {
                    field.isAccessible = true
                    (field.get(MapboxConfig) as? String)?.startsWith("pk.") == true
                }.getOrDefault(false)
        }
        assertNull("MapboxConfig must not carry a literal token", literalToken)
    }
}
