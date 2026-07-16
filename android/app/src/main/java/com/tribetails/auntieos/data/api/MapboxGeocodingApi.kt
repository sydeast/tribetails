package com.tribetails.auntieos.data.api

import com.google.gson.annotations.SerializedName
import retrofit2.http.GET
import retrofit2.http.Path
import retrofit2.http.Query

data class MapboxGeocodingResponse(
    val features: List<GeocodingFeature> = emptyList()
)

data class GeocodingFeature(
    @SerializedName("place_name") val placeName: String = ""
)

interface MapboxGeocodingApi {
    @GET("geocoding/v5/mapbox.places/{query}.json")
    suspend fun suggest(
        @Path("query") query: String,
        @Query("access_token") token: String,
        @Query("country") country: String = "us",
        @Query("types") types: String = "address",
        @Query("limit") limit: Int = 5,
    ): MapboxGeocodingResponse
}
