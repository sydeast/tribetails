package com.tribetails.auntieos.data.api

import com.google.gson.annotations.SerializedName
import retrofit2.http.GET

interface TwilioApi {
    @GET("get-token")
    suspend fun getToken(): TokenResponse
}

data class TokenResponse(
    @SerializedName("token") val token: String
)
