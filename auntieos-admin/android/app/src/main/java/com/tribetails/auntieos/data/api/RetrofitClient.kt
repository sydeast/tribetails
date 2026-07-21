package com.tribetails.auntieos.data.api

import com.tribetails.auntieos.BuildConfig
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Returns [HttpLoggingInterceptor.Level.BODY] in debug builds and
 * [HttpLoggingInterceptor.Level.NONE] in release builds, preventing
 * Authorization headers and full response bodies (including PII) from
 * being written to logcat in production.
 */
internal fun resolveHttpLogLevel(isDebug: Boolean): HttpLoggingInterceptor.Level =
    if (isDebug) HttpLoggingInterceptor.Level.BODY else HttpLoggingInterceptor.Level.NONE

object RetrofitClient {

    const val DEFAULT_BASE_URL = "https://n8n.tribetails.com/"
    const val LEGACY_N8N_HOST = "auntie.tribetails.com"
    const val TWILIO_BASE_URL  = "https://tribetailsattendant-8587.twil.io/"

    // n8n client - specifically designed with high timeouts since n8n generates AI text
    fun buildN8n(baseUrl: String): N8nApi {
        val client = OkHttpClient.Builder()
            .connectTimeout(120, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .addInterceptor(loggingInterceptor())
            .build()

        return Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(N8nApi::class.java)
    }

    // Twilio Functions client
    fun buildTwilio(): TwilioApi {
        val client = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .addInterceptor(loggingInterceptor())
            .build()

        return Retrofit.Builder()
            .baseUrl(TWILIO_BASE_URL)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(TwilioApi::class.java)
    }

    private const val MAPBOX_BASE_URL = "https://api.mapbox.com/"

    fun buildMapboxGeocoding(): MapboxGeocodingApi {
        val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .build()
        return Retrofit.Builder()
            .baseUrl(MAPBOX_BASE_URL)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(MapboxGeocodingApi::class.java)
    }

    private fun loggingInterceptor() = HttpLoggingInterceptor().apply {
        level = resolveHttpLogLevel(BuildConfig.DEBUG)
    }
}
