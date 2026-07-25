package com.tribetails.auntieos.data.api

import com.tribetails.auntieos.data.repository.AuntieRepository

/**
 * Mapbox Search Box client, backed by the MyTribe `mapboxSearch` /
 * `mapboxRetrieve` callables. No Mapbox key ships in this app.
 *
 * MIGRATED 2026-07-25. This class previously POSTed to
 * `https://auntieos-ttpc.web.app/api/mapbox/sign-search`, a hosting rewrite in
 * the retired `auntieos-admin/web` tree, with a hand-built bearer header off
 * `currentAdminIdToken`. Those are now two deployed onCall functions in the
 * mytribe codebase holding `MAPBOX_ACCESS_TOKEN` as a Functions secret, reached
 * through the same FirebaseFunctions instance as every other callable, so auth
 * is the SDK's job rather than a hand-rolled Authorization header.
 *
 * Session-token rules per Mapbox billing: one token per search session, reused
 * across every [suggest] keystroke, handed to [retrieve] for the picked
 * suggestion, and rotated only after that. A fresh token per keystroke bills
 * each keystroke as its own session.
 */
class MapboxClient(private val repository: AuntieRepository) {

    sealed class SuggestResult {
        data class Ok(val suggestions: List<MapboxSuggestion>) : SuggestResult()
        data class Err(val message: String) : SuggestResult()
    }

    sealed class RetrieveResult {
        data class Ok(val feature: MapboxFeature) : RetrieveResult()
        data class Err(val message: String) : RetrieveResult()
    }

    suspend fun suggest(query: String, sessionToken: String, limit: Int = 5): SuggestResult =
        repository.mapboxSuggest(query, sessionToken, limit).fold(
            onSuccess = { SuggestResult.Ok(it) },
            onFailure = { SuggestResult.Err(it.message ?: "Mapbox lookup failed") },
        )

    suspend fun retrieve(mapboxId: String, sessionToken: String): RetrieveResult =
        repository.mapboxRetrieve(mapboxId, sessionToken).fold(
            onSuccess = { RetrieveResult.Ok(it) },
            onFailure = { RetrieveResult.Err(it.message ?: "Mapbox retrieve failed") },
        )
}

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
    val latitude: Double = 0.0,
) {
    val resolvedAddress: String get() = fullAddress.ifBlank { name }
}

/**
 * 32-char hex session token for Mapbox Search Box billing grouping. Only needs
 * uniqueness within one search session, not crypto strength: it is a billing
 * key, not a secret.
 */
internal fun newMapboxSessionToken(): String {
    val chars = "0123456789abcdef"
    return buildString(32) { repeat(32) { append(chars.random()) } }
}
