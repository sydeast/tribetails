package com.tribetails.auntieos.config

object MapboxConfig {
    // ACCESS_TOKEN was here until 2026-07-25. It was a live Mapbox key compiled
    // into the APK, read by exactly one caller (AddressAutocompleteField's
    // direct geocoding request). Anyone with the APK could extract it and spend
    // the account's quota. Address lookup now goes through the `mapboxSearch` /
    // `mapboxRetrieve` callables, which hold the token as a Functions secret, so
    // no Mapbox key ships in any client. What is left in this file is display
    // config, not credentials.
    //
    // The token itself should still be ROTATED in the Mapbox console: it was in
    // git history, so deleting the constant does not un-publish it.

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
