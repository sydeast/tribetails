package com.kinfolk.portal.firebase

import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Firebase Callable Functions over HTTPS.
 *
 * Endpoint: https://{region}-{projectId}.cloudfunctions.net/{name}
 * Body: {"data": <payload>}
 * Header: Authorization: Bearer <idToken>
 * Response: {"result": <payload>}  on success
 *           {"error": {...}}        on failure
 */
internal class RestFunctionsClient(
    private val auth: RestAuthBackend,
    private val region: String = "us-central1",
) : FunctionsClient {

    override suspend fun call(name: String, payload: JsonObject?): JsonObject {
        val token = auth.idToken() ?: throw IllegalStateException("Not signed in.")
        val url = "https://$region-${FirebaseRestConfig.PROJECT_ID}.cloudfunctions.net/$name"
        val bodyJson = buildJsonObject {
            put("data", payload ?: JsonNull)
        }
        val res: HttpResponse = RestHttp.client.post(url) {
            contentType(ContentType.Application.Json)
            headers { append(HttpHeaders.Authorization, "Bearer $token") }
            setBody(bodyJson.toString())
        }
        if (!res.status.isSuccess()) {
            throw FirebaseRestException("call $name", res.status.value, res.bodyAsText())
        }
        val rawText = res.bodyAsText()
        val parsed = RestHttp.json.parseToJsonElement(rawText)
        val obj = parsed as? JsonObject ?: throw IllegalStateException("Bad callable response: $rawText")
        if (obj.containsKey("error")) {
            throw FirebaseRestException("call $name", res.status.value, obj["error"].toString())
        }
        return when (val result = obj["result"]) {
            is JsonObject -> result
            null, is JsonNull -> JsonObject(emptyMap())
            else -> buildJsonObject { put("value", result) }
        }
    }
}
