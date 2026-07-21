package com.tribetails.auntieos.data.api

import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Function-proxied Mapbox Search Box client. Mirrors the web `MapboxClient`
 * shape exactly so the same `/api/mapbox/sign-search` + `/api/mapbox/retrieve`
 * Functions handle both platforms. Secret access token never ships in the
 * Android bundle.
 *
 * Session-token rules per Mapbox billing: callers reuse the same
 * [sessionToken] across keystrokes for one search session, then call
 * [retrieve] with the same token when the user picks a suggestion.
 */
class MapboxClient(private val repository: AuntieRepository) {
    private val http = OkHttpClient()
    private val baseUrl = "https://auntieos-ttpc.web.app"

    sealed class SuggestResult {
        data class Ok(val suggestions: List<MapboxSuggestion>) : SuggestResult()
        data class Err(val message: String) : SuggestResult()
    }

    sealed class RetrieveResult {
        data class Ok(val feature: MapboxFeature) : RetrieveResult()
        data class Err(val message: String) : RetrieveResult()
    }

    suspend fun suggest(query: String, sessionToken: String, limit: Int = 5): SuggestResult =
        withContext(Dispatchers.IO) {
            val idToken = repository.currentAdminIdToken(forceRefresh = false).getOrElse {
                return@withContext SuggestResult.Err("Admin sign-in required")
            }
            val payload = JSONObject()
                .put("query", query)
                .put("sessionToken", sessionToken)
                .put("limit", limit)
                .toString()
            try {
                val req = Request.Builder()
                    .url("$baseUrl/api/mapbox/sign-search")
                    .header("Authorization", "Bearer $idToken")
                    .post(payload.toRequestBody("application/json".toMediaTypeOrNull()))
                    .build()
                http.newCall(req).execute().use { resp ->
                    val body = resp.body?.string().orEmpty()
                    if (!resp.isSuccessful) {
                        return@withContext SuggestResult.Err("Mapbox lookup failed (HTTP ${resp.code})")
                    }
                    SuggestResult.Ok(parseSuggestions(JSONObject(body)))
                }
            } catch (t: Throwable) {
                AuntieLog.e("Mapbox suggest failed", t)
                SuggestResult.Err(t.message ?: "Mapbox lookup failed")
            }
        }

    suspend fun retrieve(mapboxId: String, sessionToken: String): RetrieveResult =
        withContext(Dispatchers.IO) {
            val idToken = repository.currentAdminIdToken(forceRefresh = false).getOrElse {
                return@withContext RetrieveResult.Err("Admin sign-in required")
            }
            val payload = JSONObject()
                .put("mapboxId", mapboxId)
                .put("sessionToken", sessionToken)
                .toString()
            try {
                val req = Request.Builder()
                    .url("$baseUrl/api/mapbox/retrieve")
                    .header("Authorization", "Bearer $idToken")
                    .post(payload.toRequestBody("application/json".toMediaTypeOrNull()))
                    .build()
                http.newCall(req).execute().use { resp ->
                    val body = resp.body?.string().orEmpty()
                    if (!resp.isSuccessful) {
                        return@withContext RetrieveResult.Err("Mapbox retrieve failed (HTTP ${resp.code})")
                    }
                    val featureObj = JSONObject(body).optJSONObject("feature")
                        ?: return@withContext RetrieveResult.Err("Mapbox returned no feature")
                    RetrieveResult.Ok(parseFeature(featureObj))
                }
            } catch (t: Throwable) {
                AuntieLog.e("Mapbox retrieve failed", t)
                RetrieveResult.Err(t.message ?: "Mapbox retrieve failed")
            }
        }

    private fun parseSuggestions(json: JSONObject): List<MapboxSuggestion> {
        val arr = json.optJSONArray("suggestions") ?: return emptyList()
        val out = ArrayList<MapboxSuggestion>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            out.add(
                MapboxSuggestion(
                    name           = o.optString("name"),
                    fullAddress    = o.optString("full_address"),
                    mapboxId       = o.optString("mapbox_id"),
                    placeFormatted = o.optString("place_formatted"),
                )
            )
        }
        return out
    }

    private fun parseFeature(o: JSONObject): MapboxFeature {
        val geom = o.optJSONObject("geometry")
        val props = o.optJSONObject("properties")
        val coords = geom?.optJSONArray("coordinates")
        val lng = coords?.optDouble(0, 0.0) ?: 0.0
        val lat = coords?.optDouble(1, 0.0) ?: 0.0
        return MapboxFeature(
            name           = props?.optString("name").orEmpty(),
            fullAddress    = props?.optString("full_address").orEmpty(),
            placeFormatted = props?.optString("place_formatted").orEmpty(),
            longitude      = lng,
            latitude       = lat,
        )
    }
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

internal fun newMapboxSessionToken(): String {
    val chars = "0123456789abcdef"
    return buildString(32) { repeat(32) { append(chars.random()) } }
}
