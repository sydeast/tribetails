package com.tribetails.auntieos.web.data

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val mapboxJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    coerceInputValues = true
}

private val mapboxHttp = HttpClient {
    install(ContentNegotiation) {
        json(mapboxJson)
    }
}

@Serializable
private data class MapboxSuggestRequest(
    val query: String,
    val sessionToken: String,
    val limit: Int,
)

@Serializable
private data class MapboxRetrieveRequest(
    val mapboxId: String,
    val sessionToken: String,
)

internal actual suspend fun platformMapboxSuggest(
    query: String,
    sessionToken: String,
    limit: Int,
): MapboxSuggestResult {
    val idToken = AuthClient().idToken(forceRefresh = false)
        ?: return MapboxSuggestResult.Err("Admin sign-in required")
    return runCatching {
        val response = mapboxHttp.post("/api/mapbox/sign-search") {
            contentType(ContentType.Application.Json)
            header("Authorization", "Bearer $idToken")
            setBody(MapboxSuggestRequest(query = query, sessionToken = sessionToken, limit = limit))
        }
        if (!response.status.isSuccess()) {
            return MapboxSuggestResult.Err("Mapbox lookup failed (HTTP ${response.status.value})")
        }
        val body: MapboxSuggestResponse = response.body()
        MapboxSuggestResult.Ok(body.suggestions)
    }.getOrElse { MapboxSuggestResult.Err(it.message ?: "Mapbox lookup failed") }
}

internal actual suspend fun platformMapboxRetrieve(
    mapboxId: String,
    sessionToken: String,
): MapboxRetrieveResult {
    val idToken = AuthClient().idToken(forceRefresh = false)
        ?: return MapboxRetrieveResult.Err("Admin sign-in required")
    return runCatching {
        val response = mapboxHttp.post("/api/mapbox/retrieve") {
            contentType(ContentType.Application.Json)
            header("Authorization", "Bearer $idToken")
            setBody(MapboxRetrieveRequest(mapboxId = mapboxId, sessionToken = sessionToken))
        }
        if (!response.status.isSuccess()) {
            return MapboxRetrieveResult.Err("Mapbox retrieve failed (HTTP ${response.status.value})")
        }
        val body: MapboxRetrieveResponse = response.body()
        val feature = body.feature
            ?: return MapboxRetrieveResult.Err("Mapbox returned no feature")
        MapboxRetrieveResult.Ok(feature)
    }.getOrElse { MapboxRetrieveResult.Err(it.message ?: "Mapbox retrieve failed") }
}
