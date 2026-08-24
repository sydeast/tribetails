package com.kinfolk.portal.config

import com.mapbox.common.MapboxOptions

/**
 * The portal Android app's Mapbox credential, and the record of what startup did
 * with it.
 *
 * A sibling of `com.tribetails.auntieos.config.MapboxConfig`, deliberately
 * copied rather than shared: the two apps are separate Gradle builds with no
 * common module between them, and nothing in this repository publishes one to
 * the other. Keep them in step by hand when either changes.
 *
 * The Maps SDK fetches vector tiles on the device, so a token has to be ON the
 * device for a basemap to draw at all; there is no server-proxy alternative the
 * way there is for a geocoding lookup, which is why the `mapboxSearch` /
 * `mapboxRetrieve` callables still hold the geocoding key and no client regains
 * one. What makes this defensible is blast radius rather than concealment, which
 * is impossible on Android: the mobile token is a read-only `pk.` scoped to
 * styles and fonts, it arrives from a gradle property instead of source, and it
 * can be rotated without touching the web maps, which use a different token.
 */
object MapboxPortalConfig {

    /**
     * What startup did about the access token, recorded so both the tests and
     * [com.kinfolk.portal.components.RouteMapSurface] can tell the three
     * outcomes apart.
     *
     * The distinction that matters is [NeverConsulted] versus
     * [NoTokenConfigured]. A boolean collapses "nothing ever asked" into "asked,
     * and there was nothing to hand over"; the first is the defect that left the
     * AuntieOS maps blank since they were written, and the second is an ordinary
     * token-less build.
     */
    sealed interface TokenApplication {
        /** [applyAccessToken] has not run. No MapView may be built in this state. */
        object NeverConsulted : TokenApplication

        /** Ran, and the build carries no token. RouteMap falls back to the Canvas polyline. */
        object NoTokenConfigured : TokenApplication

        /**
         * The token was handed to the SDK. Recorded BEFORE the handover, so a
         * native failure inside the SDK still leaves evidence that startup did
         * its part; [deliveryError] carries what went wrong if anything did.
         */
        data class Delivered(val token: String, val deliveryError: Throwable? = null) : TokenApplication
    }

    @Volatile
    var startupTokenApplication: TokenApplication = TokenApplication.NeverConsulted
        private set

    /**
     * Where the token actually goes. A seam only so the unit test can watch the
     * handover: the real sink is a native SDK call that throws
     * `UnsatisfiedLinkError` under Robolectric, so nothing can read the applied
     * value back in a JVM test.
     *
     * Process-wide mutable state in a single-JVM suite is what cost this
     * codebase issue #425, so any test that replaces it MUST restore it in an
     * `@After` - see [resetForTests].
     */
    @Volatile
    internal var accessTokenSink: (String) -> Unit = { MapboxOptions.accessToken = it }

    /**
     * Gives the Maps SDK its access token. Called from
     * `KinfolkPortalApplication.onCreate`, which Android runs before any Activity
     * or Composable exists, so the token is in place before the first
     * `MapView(context)` can be constructed.
     *
     * Never throws. A blank token is a legitimate build - RouteMap then draws the
     * Canvas polyline, exactly what shipped before issue #520 - and a native
     * failure inside the SDK must not take down an app whose other screens do not
     * involve a map at all.
     */
    fun applyAccessToken(token: String): TokenApplication {
        val outcome = if (token.isBlank()) {
            TokenApplication.NoTokenConfigured
        } else {
            startupTokenApplication = TokenApplication.Delivered(token)
            try {
                accessTokenSink(token)
                TokenApplication.Delivered(token)
            } catch (t: Throwable) {
                TokenApplication.Delivered(token, deliveryError = t)
            }
        }
        startupTokenApplication = outcome
        return outcome
    }

    /** Test-only. Mirrors `MapboxConfig.resetForTests` in the AuntieOS app. */
    internal fun resetForTests(sink: (String) -> Unit = { MapboxOptions.accessToken = it }) {
        accessTokenSink = sink
        startupTokenApplication = TokenApplication.NeverConsulted
    }

    /** Same basemap the AuntieOS route viewer uses, so both apps show one map. */
    const val DEFAULT_STYLE = "mapbox://styles/mapbox/streets-v12"

    // Hex copies of KinfolkBrand.KinTeal / KinfolkOrange / PackPink, so the
    // basemap and the Canvas fallback draw the same route in the same colours
    // and switching between them is not visible as a palette change. Mapbox's
    // annotation API takes CSS strings, not Compose Colors, which is why these
    // are duplicated here rather than read from theme/Theme.kt.
    /** KinfolkBrand.KinTeal, 0xFF0A8595. */
    const val ROUTE_LINE_COLOR = "#0A8595"
    const val ROUTE_LINE_WIDTH = 5.0

    /** KinfolkBrand.KinfolkOrange, 0xFFDF8431. The first ping. */
    const val ROUTE_START_COLOR = "#DF8431"

    /** KinfolkBrand.PackPink, 0xFFD55C87. The last ping. */
    const val ROUTE_END_COLOR = "#D55C87"

    /** Zoom for a single-ping route, where a bounding box is degenerate. */
    const val SINGLE_POINT_ZOOM = 16.0
}
