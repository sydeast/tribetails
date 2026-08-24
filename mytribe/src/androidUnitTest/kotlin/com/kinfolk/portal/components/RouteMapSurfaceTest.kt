package com.kinfolk.portal.components

import com.kinfolk.portal.config.MapboxPortalConfig
import com.mapbox.maps.MapLoadingErrorType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The fallback, which is the whole safety story of the issue #520 design: no
 * arrangement of missing token or refused basemap may leave a kinfolk looking at
 * an empty rectangle. The floor is the Canvas polyline they already had.
 *
 * These run as plain JUnit with no Robolectric and no Compose host, because
 * `routeSurfaceFor` is a pure function of the two facts that decide the
 * question. That is deliberate: the alternative, asserting on rendered output,
 * would need `runComposeUiTest`, which cannot run under `testDebugUnitTest` at
 * all (issue #473 - the Android unit-test variant links against the stub
 * android.jar and the Compose test host dies on a null `Build.FINGERPRINT`).
 *
 * Making the choice a pure function is also what makes "the token is applied
 * before any MapView is constructed" structural rather than a convention. There
 * is no branch that reaches a `MapView` constructor while the recorded token
 * application is anything other than `Delivered`, so the SDK can never be asked
 * to load a style it has no credential for.
 */
class RouteMapSurfaceTest {

    private val delivered = MapboxPortalConfig.TokenApplication.Delivered("pk.test-token")

    @Test
    fun no_token_configured_falls_back_to_the_canvas_polyline() {
        assertEquals(
            "a build with no MAPBOX_PUBLIC_TOKEN must draw the polyline, not a blank box",
            RouteSurface.Canvas,
            routeSurfaceFor(
                tokenApplication = MapboxPortalConfig.TokenApplication.NoTokenConfigured,
                tilesFailed = false,
            ),
        )
    }

    @Test
    fun a_token_that_startup_never_consulted_falls_back_to_the_canvas_polyline() {
        // The AuntieOS defect exactly: SDK wired, screens written, nothing ever
        // authenticated it. Here that state cannot reach a MapView at all.
        assertEquals(
            RouteSurface.Canvas,
            routeSurfaceFor(
                tokenApplication = MapboxPortalConfig.TokenApplication.NeverConsulted,
                tilesFailed = false,
            ),
        )
    }

    @Test
    fun a_delivered_token_draws_the_real_basemap() {
        assertEquals(
            "with a token applied a kinfolk must get streets, which is the point of #520",
            RouteSurface.Basemap,
            routeSurfaceFor(tokenApplication = delivered, tilesFailed = false),
        )
    }

    @Test
    fun a_basemap_that_failed_to_load_falls_back_even_though_the_token_was_delivered() {
        // Revoked token, a scope that does not cover styles, an offline device:
        // the credential was handed over and the map still did not arrive.
        assertEquals(
            RouteSurface.Canvas,
            routeSurfaceFor(tokenApplication = delivered, tilesFailed = true),
        )
    }

    @Test
    fun a_token_delivered_but_rejected_by_the_native_sdk_still_starts_on_the_basemap() {
        // Delivery errors are recorded, not fatal. If the SDK then cannot load a
        // style it reports a STYLE error and the tilesFailed path takes over,
        // which is the case above. Pinned so nobody "tidies" deliveryError into
        // a fallback trigger and blanks a map that would have worked.
        val withError = MapboxPortalConfig.TokenApplication.Delivered(
            token = "pk.test-token",
            deliveryError = UnsatisfiedLinkError("no native library in a unit test"),
        )
        assertEquals(RouteSurface.Basemap, routeSurfaceFor(withError, tilesFailed = false))
    }

    @Test
    fun style_and_source_failures_are_fatal_to_the_basemap() {
        // A 401 from a revoked or wrongly-scoped token surfaces as a style-load
        // failure. That is the case this fallback is really for.
        assertTrue(isFatalMapLoadingError(MapLoadingErrorType.STYLE))
        assertTrue(isFatalMapLoadingError(MapLoadingErrorType.SOURCE))
    }

    @Test
    fun partial_failures_do_not_drop_a_working_map_to_a_line_drawing() {
        // One tile missing at the edge of a pan, or an icon that did not fetch.
        // Falling back on these would be a regression, not a rescue.
        assertFalse(isFatalMapLoadingError(MapLoadingErrorType.TILE))
        assertFalse(isFatalMapLoadingError(MapLoadingErrorType.SPRITE))
        assertFalse(isFatalMapLoadingError(MapLoadingErrorType.GLYPHS))
    }
}
