package com.kinfolk.portal.firebase

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.headers
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.URLBuilder
import io.ktor.http.isSuccess
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Firestore REST v1.
 *  GET /projects/{p}/databases/{d}/documents/{collection}/{docId}
 *  GET /projects/{p}/databases/{d}/documents/{collection}            (list)
 *
 * We only implement read paths used by AdminHomeScreen + LaunchRouter.
 * Writes can be added later.
 *
 * #889: every request here carries the signed-in kinfolk's own ID token
 * ([idToken]), never the Firestore emulator's Bearer owner bypass, on
 * purpose, see [FirebaseRestConfig.firestoreBase]. [root] is emulator-aware
 * (FIRESTORE_EMULATOR_HOST); the auth header is not.
 *
 * #889 review, item 5: the primary constructor takes an [idToken] supplier
 * plus [client]/[endpoints], so a test can inject a MockEngine client and a
 * plain lambda and assert the outgoing URL. [FirebasePlatform.jvm.kt] keeps
 * constructing this from a [RestAuthBackend] through the secondary
 * constructor below, unchanged at that call site.
 */
internal class RestFirestoreClient(
    private val idToken: suspend () -> String?,
    private val client: HttpClient = RestHttp.client,
    private val endpoints: RestEndpoints = FirebaseRestConfig,
) : FirestoreClient {

    constructor(
        auth: RestAuthBackend,
        client: HttpClient = RestHttp.client,
        endpoints: RestEndpoints = FirebaseRestConfig,
    ) : this(auth::idToken, client, endpoints)

    private val root = endpoints.firestoreBase()

    /** REST has no listen channel — return an empty flow so jvm dev runs don't crash.
     *  Live tracking only works on android/js builds (gitlive). */
    override fun breadcrumbsStream(sessionId: String): kotlinx.coroutines.flow.Flow<List<com.kinfolk.portal.components.RoutePoint>> =
        kotlinx.coroutines.flow.flowOf(emptyList())

    override suspend fun getDocument(collection: String, documentId: String): Map<String, Any?>? {
        val url = "$root/$collection/$documentId"
        val token = idToken() ?: return null
        val res = client.get(url) {
            headers { append(HttpHeaders.Authorization, "Bearer $token") }
        }
        if (res.status.value == 404) return null
        if (!res.status.isSuccess()) {
            throw FirebaseRestException("getDocument $collection/$documentId", res.status.value, res.bodyAsText())
        }
        val body: RestDocument = res.body()
        return body.fields?.let { decodeFields(it) } ?: emptyMap()
    }

    override suspend fun listDocuments(collection: String): List<FirestoreDoc> {
        val token = idToken() ?: throw IllegalStateException("Not signed in")
        val out = mutableListOf<FirestoreDoc>()
        var pageToken: String? = null
        do {
            val builder = URLBuilder("$root/$collection")
            builder.parameters.append("pageSize", "100")
            if (pageToken != null) builder.parameters.append("pageToken", pageToken)
            val url = builder.buildString()
            val res: HttpResponse = client.get(url) {
                headers { append(HttpHeaders.Authorization, "Bearer $token") }
            }
            if (!res.status.isSuccess()) {
                throw FirebaseRestException("listDocuments $collection", res.status.value, res.bodyAsText())
            }
            val page: RestDocumentListResponse = res.body()
            page.documents?.forEach { doc ->
                val name = doc.name ?: return@forEach
                val id = name.substringAfterLast('/')
                val fields = doc.fields?.let { decodeFields(it) } ?: emptyMap()
                out.add(FirestoreDoc(id = id, fields = fields))
            }
            pageToken = page.nextPageToken
        } while (pageToken != null)
        return out
    }

    @Serializable
    private data class RestDocument(
        val name: String? = null,
        val fields: JsonObject? = null,
    )

    @Serializable
    private data class RestDocumentListResponse(
        val documents: List<RestDocument>? = null,
        val nextPageToken: String? = null,
    )

    private fun decodeFields(fields: JsonObject): Map<String, Any?> =
        fields.mapValues { (_, v) -> decodeValue(v) }

    /** Convert a Firestore REST `Value` JSON object to a plain Kotlin value. */
    private fun decodeValue(el: JsonElement): Any? {
        if (el !is JsonObject) return null
        val (k, v) = el.entries.firstOrNull() ?: return null
        return when (k) {
            "stringValue" -> v.jsonPrimitive.contentOrNull
            "booleanValue" -> v.jsonPrimitive.booleanOrNull
            "integerValue" -> v.jsonPrimitive.contentOrNull?.toLongOrNull()
            "doubleValue" -> v.jsonPrimitive.doubleOrNull
            "timestampValue" -> v.jsonPrimitive.contentOrNull // ISO-8601
            "nullValue" -> null
            "referenceValue" -> v.jsonPrimitive.contentOrNull
            "geoPointValue" -> (v as? JsonObject)?.let { obj ->
                val lat = obj["latitude"]?.jsonPrimitive?.doubleOrNull
                val lng = obj["longitude"]?.jsonPrimitive?.doubleOrNull
                if (lat != null && lng != null) doubleArrayOf(lat, lng) else null
            }
            "bytesValue" -> v.jsonPrimitive.contentOrNull
            "arrayValue" -> {
                val arr = (v as? JsonObject)?.get("values") as? JsonArray
                arr?.map { decodeValue(it) }
            }
            "mapValue" -> {
                val inner = (v as? JsonObject)?.get("fields") as? JsonObject
                inner?.let { decodeFields(it) }
            }
            else -> null
        }
    }
}
