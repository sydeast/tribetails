package com.tribetails.auntieos.config

object MapboxConfig {
    // Replace with your actual Mapbox public token from your account
    const val ACCESS_TOKEN = "pk.eyJ1IjoidHJpYmVhZG1pbiIsImEiOiJjbW41NXE4bG8wNnkxMnBweG1vdXozZTkyIn0.CTaKFpJN8NzuKfTHyXyBjw"

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
