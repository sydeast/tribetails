package com.tribetails.auntieos.data.api

import com.tribetails.auntieos.data.model.*
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.Header
import retrofit2.http.POST

interface N8nApi {

    @POST("webhook/auntie-generate")
    suspend fun generate(@Body request: GenerateRequest): Response<GenerateResponse>

    // Admin-only Firebase `generate` function (replaces the n8n webhook above).
    // Absolute URL like sendMessage; needs a Bearer Firebase ID token.
    @POST("https://auntieos-ttpc.web.app/api/generate")
    suspend fun generateViaFunction(
        @Header("Authorization") authorization: String,
        @Body request: GenerateRequest,
    ): Response<GenerateResponse>

    @POST("webhook/auntie-update-profiles")
    suspend fun updateProfiles(@Body request: ApproveRequest): Response<Unit>

    @POST("https://auntieos-ttpc.web.app/api/send-message")
    suspend fun sendMessage(
        @Header("Authorization") authorization: String,
        @Body request: SendMessageRequest
    ): Response<SendMessageResponse>
}
