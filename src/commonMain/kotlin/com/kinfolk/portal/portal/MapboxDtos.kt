package com.kinfolk.portal.portal

/**
 * Mapbox Search Box autocomplete suggestion. Returned by [PortalApi.mapboxSearch].
 * Field names match the Mapbox API response so future schema additions don't
 * require translation.
 */
data class MapboxSuggestion(
    val name: String = "",
    val fullAddress: String = "",
    val mapboxId: String = "",
    val placeFormatted: String = "",
)

data class MapboxFeature(
    val name: String = "",
    val fullAddress: String = "",
    val placeFormatted: String = "",
    val longitude: Double = 0.0,
    val latitude:  Double = 0.0,
) {
    val resolvedAddress: String get() = fullAddress.ifBlank { name }
}

/** Generates a Mapbox session token (32 hex chars). Reuse across keystrokes
 *  in one search session, then rotate after [PortalApi.mapboxRetrieve]. */
fun newMapboxSessionToken(): String {
    val chars = "0123456789abcdef"
    return buildString(32) { repeat(32) { append(chars.random()) } }
}
