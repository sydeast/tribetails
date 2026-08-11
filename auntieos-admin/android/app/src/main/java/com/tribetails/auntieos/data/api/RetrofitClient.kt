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

    /**
     * Retrofit's `baseUrl(String)` REJECTS a URL that does not end in '/'
     * (IllegalArgumentException: "baseUrl must end in /"). Settings used to store
     * `url.trimEnd('/')`, which guaranteed the throw on every save and left a
     * slash-less value in DataStore that also failed at startup. Normalize here,
     * at the single point of consumption, so an already-poisoned stored value
     * heals on next launch.
     *
     * Blank input falls back to [DEFAULT_BASE_URL]. A URL with no scheme is NOT
     * repaired: Retrofit rejects it and the caller surfaces the error, because
     * guessing http vs https for the operator would be a silent wrong answer.
     */
    fun normalizeBaseUrl(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return DEFAULT_BASE_URL
        return trimmed.trimEnd('/') + "/"
    }

    // n8n client - specifically designed with high timeouts since n8n generates AI text
    fun buildN8n(rawBaseUrl: String): N8nApi {
        val baseUrl = normalizeBaseUrl(rawBaseUrl)
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

    // No Twilio client here any more. `buildTwilio` used to bind a Retrofit
    // TwilioApi to https://tribetailsattendant-8587.twil.io/, whose `get-token`
    // handler was PUBLIC: no arguments, no auth check, and it returned a token
    // granting `incomingAllow` for the `auntie` identity, so anyone with the URL
    // could register as that client and answer the business's inbound calls. It
    // had also been 404ing, which is how the app shipped with voice quietly
    // unregistered. Token minting now goes through the admin-gated
    // `mintVoiceAccessToken` callable (AuntieRepository, VoiceTokenManager).

    // No Mapbox client here any more. `buildMapboxGeocoding` used to hand back
    // a Retrofit binding to api.mapbox.com that callers authenticated with
    // MapboxConfig.ACCESS_TOKEN, which meant a live Mapbox key sat in the APK.
    // Address lookup now goes through the `mapboxSearch` / `mapboxRetrieve`
    // callables (AuntieRepository), which hold the token as a Functions secret.

    private fun loggingInterceptor() = HttpLoggingInterceptor().apply {
        level = resolveHttpLogLevel(BuildConfig.DEBUG)
    }
}
