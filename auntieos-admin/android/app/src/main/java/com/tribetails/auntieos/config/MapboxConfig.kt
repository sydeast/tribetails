package com.tribetails.auntieos.config

import com.mapbox.common.MapboxOptions

object MapboxConfig {
    // ACCESS_TOKEN was here until 2026-07-25. It was a live Mapbox key compiled
    // into the APK, read by exactly one caller (AddressAutocompleteField's
    // direct geocoding request). Anyone with the APK could extract it and spend
    // the account's quota. Address lookup goes through the `mapboxSearch` /
    // `mapboxRetrieve` callables now, which hold the token as a Functions
    // secret, and that stays true: no client regains a geocoding key. The leaked
    // token has since been revoked in the Mapbox console.
    //
    // [applyAccessToken] below is a different question, not a reversal of that
    // one. The Maps SDK fetches vector tiles on the device, so a token has to be
    // ON the device for a basemap to draw at all; there is no server-proxy
    // alternative the way there is for a geocoding lookup. What makes it
    // defensible is blast radius rather than concealment, which is impossible on
    // Android: the mobile token is a read-only `pk.` scoped to styles and fonts,
    // it arrives from a gradle property instead of source, and it can be
    // rotated without touching the web maps, which use a different token.

    /**
     * What startup did about the access token, recorded so a test can tell the
     * three outcomes apart.
     *
     * The distinction that matters is [NeverConsulted] versus [NoTokenConfigured].
     * Until this PR the answer was permanently the first one: `MapboxOptions`,
     * `setAccessToken` and a `mapbox_access_token` resource had never existed
     * anywhere in this repository's Android history, so `LiveTrackingScreen` and
     * `RouteViewerScreen` built real `MapView`s that no credential ever reached.
     * A boolean cannot say that; it collapses "nothing ever asked" into "asked,
     * and there was nothing to hand over", which is an ordinary build.
     */

    sealed interface TokenApplication {
        /** [applyAccessToken] has not run. Before this PR, the permanent state. */
        object NeverConsulted : TokenApplication

        /** Ran, and the build carries no token. Maps stay blank; nothing else degrades. */
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
     * Process-wide mutable state in a single-JVM suite is exactly what cost this
     * codebase issue #425, so any test that replaces it MUST restore it in an
     * `@After` - see [resetForTests].
     */
    @Volatile
    internal var accessTokenSink: (String) -> Unit = { MapboxOptions.accessToken = it }

    /**
     * Gives the Maps SDK its access token. Called from `AuntieOSApp.onCreate`,
     * which Android runs before any Activity or Composable exists, so the token
     * is in place before the first `MapView(context)` can be constructed.
     *
     * Never throws. A blank token is a legitimate build (the maps are then blank,
     * which is exactly what shipped before this) and a native failure inside the
     * SDK must not take down an app whose other twenty screens do not involve a
     * map.
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

    /** Mirrors `VoiceTokenManager.resetForTests`. Test-only. */
    internal fun resetForTests(sink: (String) -> Unit = { MapboxOptions.accessToken = it }) {
        accessTokenSink = sink
        startupTokenApplication = TokenApplication.NeverConsulted
    }

    // Style configurations for different map styles
    const val DEFAULT_STYLE = "mapbox://styles/mapbox/streets-v12"
    const val SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-streets-v12"
    const val OUTDOOR_STYLE = "mapbox://styles/mapbox/outdoors-v12"

    // Location tracking settings
    const val LOCATION_UPDATE_INTERVAL = 5000L // 5 seconds
    const val LOCATION_FASTEST_INTERVAL = 2000L // 2 seconds
    const val MIN_DISTANCE_FOR_UPDATE = 5.0f // 5 meters

    // Route tracking settings
    const val ROUTE_SMOOTHING_TOLERANCE = 10.0 // meters
    const val MAX_ROUTE_POINTS = 1000 // Limit route points for performance

    // UI settings
    const val DEFAULT_ZOOM = 16.0
    const val TRACKING_ZOOM = 18.0
    const val ROUTE_LINE_WIDTH = 6.0
    const val ROUTE_LINE_COLOR = "#C8A96E" // Gold color from theme

    // Visit validation settings
    const val ARRIVAL_DETECTION_RADIUS = 50.0 // meters
    const val DEPARTURE_DETECTION_RADIUS = 100.0 // meters
    const val MIN_VISIT_DURATION = 300000L // 5 minutes in milliseconds
}
