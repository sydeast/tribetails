package com.kinfolk.portal

import com.kinfolk.portal.config.MapboxPortalConfig
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
 * Pins the invariant the portal's real map rests on: the Maps SDK is given its
 * token at startup, before anything that could build a `MapView` exists.
 *
 * The defect this guards against is the one issue #520 found next door. The
 * AuntieOS app had the SDK wired and two screens building real `MapView`s, and
 * `MapboxOptions.accessToken` had never been set anywhere in this repository's
 * Android history, so every tile request either screen made was unauthenticated
 * and both were blank from the day they were written. The portal is arriving at
 * a map with that already known, and this is what stops it repeating.
 *
 * **Why this asserts on a recording rather than on `MapboxOptions.accessToken`.**
 * Touching `MapboxOptions` under Robolectric throws `UnsatisfiedLinkError`: the
 * property is backed by the SDK's native settings service, and a JVM unit test
 * has no native library. So `MapboxPortalConfig` records what startup did with
 * the token and this asserts on the record. `MapboxPortalConfigTest` covers the
 * handover itself against a fake sink.
 *
 * **Why the expectation is derived from `BuildConfig` instead of demanding a
 * non-blank token.** A machine with no token configured still has to produce a
 * green suite; an `isNotBlank()` assertion would turn a token-less runner red
 * for a reason that has nothing to do with the code. What is under test is that
 * startup routes whatever the build carries into the SDK.
 *
 * "Before any map is constructed" is Android's own guarantee rather than
 * something this test arranges: `Application.onCreate` runs before any Activity
 * or Composable exists. `RouteMapSurfaceTest` covers the other half, that a
 * `MapView` is unreachable until this has happened.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MapboxTokenStartupTest {

    // No @Before reset: this asserts on state KinfolkPortalApplication.onCreate
    // left behind, and resetting first would erase the thing under test. The
    // @After exists because the recording and the sink are process-wide in a
    // single-JVM suite (issue #425).
    @After
    fun tearDown() {
        MapboxPortalConfig.resetForTests()
    }

    @Test
    fun creating_the_application_hands_the_build_token_to_the_maps_sdk() {
        assertTrue(
            "expected the real KinfolkPortalApplication under Robolectric",
            RuntimeEnvironment.getApplication() is KinfolkPortalApplication,
        )

        val recorded = MapboxPortalConfig.startupTokenApplication
        val configured = BuildConfig.MAPBOX_PUBLIC_TOKEN

        if (configured.isBlank()) {
            // A build with no token still has to have ASKED. NeverConsulted here
            // is the AuntieOS defect, and it is what this branch catches.
            assertEquals(
                "startup must consult MAPBOX_PUBLIC_TOKEN even when the build has none",
                MapboxPortalConfig.TokenApplication.NoTokenConfigured,
                recorded,
            )
        } else {
            assertTrue(
                "startup must hand MAPBOX_PUBLIC_TOKEN to the SDK, was $recorded",
                recorded is MapboxPortalConfig.TokenApplication.Delivered,
            )
            assertEquals(
                "the token handed over must be the one this build was configured with",
                configured,
                (recorded as MapboxPortalConfig.TokenApplication.Delivered).token,
            )
        }
    }

    @Test
    fun the_token_is_never_a_literal_in_source() {
        // The AuntieOS config object held a live key until 2026-07-25 and the
        // portal must not acquire one: the token arrives as a gradle property,
        // never as source.
        val literalToken = MapboxPortalConfig::class.java.declaredFields.firstOrNull { field ->
            field.type == String::class.java &&
                runCatching {
                    field.isAccessible = true
                    (field.get(MapboxPortalConfig) as? String)?.startsWith("pk.") == true
                }.getOrDefault(false)
        }
        assertNull("MapboxPortalConfig must not carry a literal token", literalToken)
    }
}
