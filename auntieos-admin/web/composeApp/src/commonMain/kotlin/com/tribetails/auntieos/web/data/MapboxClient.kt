package com.tribetails.auntieos.web.data

import kotlinx.serialization.Serializable

/**
 * Mapbox Search Box autocomplete. The wasmJs implementation proxies through
 * the `/api/mapbox/sign-search` and `/api/mapbox/retrieve` Firebase Functions
 * so the secret access token never ships in the public bundle.
 *
 * Session-token rules (per Mapbox billing): callers reuse the same
 * [sessionToken] across keystrokes for a single search session, then call
 * [retrieve] with that same token when the user picks a suggestion. The
 * Mapbox SDK groups suggest+retrieve into one billable session that way.
 */
class MapboxClient {
    suspend fun suggest(query: String, sessionToken: String, limit: Int = 5): MapboxSuggestResult =
        platformMapboxSuggest(query, sessionToken, limit)

    suspend fun retrieve(mapboxId: String, sessionToken: String): MapboxRetrieveResult =
        platformMapboxRetrieve(mapboxId, sessionToken)
}

@Serializable
data class MapboxSuggestion(
    val name: String = "",
    val full_address: String = "",
    val mapbox_id: String = "",
    val place_formatted: String = "",
)

@Serializable
data class MapboxSuggestResponse(
    val suggestions: List<MapboxSuggestion> = emptyList(),
    val signedBy: String = "",
)

@Serializable
data class MapboxFeatureCoordinates(
    val longitude: Double = 0.0,
    val latitude: Double = 0.0,
)

@Serializable
data class MapboxFeatureProperties(
    val name: String = "",
    val full_address: String = "",
    val place_formatted: String = "",
)

@Serializable
data class MapboxFeatureGeometry(
    val type: String = "",
    val coordinates: List<Double> = emptyList(),
)

@Serializable
data class MapboxFeature(
    val type: String = "",
    val geometry: MapboxFeatureGeometry = MapboxFeatureGeometry(),
    val properties: MapboxFeatureProperties = MapboxFeatureProperties(),
) {
    val resolvedAddress: String
        get() = properties.full_address.ifBlank { properties.name }
    val longitude: Double get() = geometry.coordinates.getOrNull(0) ?: 0.0
    val latitude:  Double get() = geometry.coordinates.getOrNull(1) ?: 0.0
}

@Serializable
data class MapboxRetrieveResponse(
    val feature: MapboxFeature? = null,
    val signedBy: String = "",
)

sealed class MapboxSuggestResult {
    data class Ok(val suggestions: List<MapboxSuggestion>) : MapboxSuggestResult()
    data class Err(val message: String) : MapboxSuggestResult()
}

sealed class MapboxRetrieveResult {
    data class Ok(val feature: MapboxFeature) : MapboxRetrieveResult()
    data class Err(val message: String) : MapboxRetrieveResult()
}

internal expect suspend fun platformMapboxSuggest(
    query: String,
    sessionToken: String,
    limit: Int,
): MapboxSuggestResult

internal expect suspend fun platformMapboxRetrieve(
    mapboxId: String,
    sessionToken: String,
): MapboxRetrieveResult
