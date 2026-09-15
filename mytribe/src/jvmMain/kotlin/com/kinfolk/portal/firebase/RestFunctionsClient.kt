package com.kinfolk.portal.firebase

import io.ktor.client.HttpClient
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
 * Endpoint: https://{region}-{projectId}.cloudfunctions.net/{name} in
 * production, or the local Functions emulator when FUNCTIONS_EMULATOR_HOST
 * is set, see [FirebaseRestConfig.functionUrl] (#889).
 * Body: {"data": <payload>}
 * Header: Authorization: Bearer <idToken>
 * Response: {"result": <payload>}  on success
 *           {"error": {...}}        on failure
 *
 * #889 review, item 5: the primary constructor takes an [idToken] supplier
 * plus [client]/[endpoints], so a test can inject a MockEngine client and a
 * plain lambda and assert the outgoing URL. [FirebasePlatform.jvm.kt] keeps
 * constructing this from a [RestAuthBackend] through the secondary
 * constructor below, unchanged at that call site.
 */
internal class RestFunctionsClient(
    private val idToken: suspend () -> String?,
    private val client: HttpClient = RestHttp.client,
    private val endpoints: RestEndpoints = FirebaseRestConfig,
    private val region: String = "us-central1",
) : FunctionsClient {

    constructor(
        auth: RestAuthBackend,
        client: HttpClient = RestHttp.client,
        endpoints: RestEndpoints = FirebaseRestConfig,
        region: String = "us-central1",
    ) : this(auth::idToken, client, endpoints, region)

    override suspend fun call(name: String, payload: JsonObject?): JsonObject {
        val token = idToken() ?: throw IllegalStateException("Not signed in.")
        val url = endpoints.functionUrl(name, region)
        val bodyJson = buildJsonObject {
            put("data", payload ?: JsonNull)
        }
        val res: HttpResponse = client.post(url) {
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
