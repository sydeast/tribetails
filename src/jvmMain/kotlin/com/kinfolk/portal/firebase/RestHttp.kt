package com.kinfolk.portal.firebase

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

internal object RestHttp {
    val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    val client: HttpClient = HttpClient(CIO) {
        install(ContentNegotiation) {
            json(this@RestHttp.json)
        }
        expectSuccess = false
    }
}
