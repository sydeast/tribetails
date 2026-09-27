package com.tribetails.auntieos.web.data

import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.net.InetSocketAddress
import java.net.URLDecoder

/**
 * A local HTTP server that stands in for Firestore REST and applies a PATCH the
 * way Firestore does: with `updateMask.fieldPaths`, only the named paths are set
 * (or deleted when the body leaves them out); without one, the body replaces the
 * whole document. Tests assert on the stored document afterwards, so they check
 * what survives, not only what was sent. Shared by the #895 kin and #994 merge
 * tests.
 */
class MaskApplyingFirestore {
    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)

    /** Stored documents by path (`collection/id`), as Firestore `fields` objects. */
    val docs = mutableMapOf<String, JsonObject>()

    /** One entry per PATCH: the decoded mask, or null for a whole-document PATCH. */
    val masks = mutableListOf<List<String>?>()

    fun start() {
        server.createContext("/") { ex ->
            val rel = ex.requestURI.rawPath.substringAfter("/documents/")
            val body = ex.requestBody.readBytes().decodeToString()
            val (status, out) = when (ex.requestMethod) {
                "GET" -> docs[rel]?.let { 200 to docJson(rel, it).toString() } ?: (404 to "{}")
                "PATCH" -> {
                    val mask = ex.requestURI.rawQuery.orEmpty().split('&')
                        .filter { it.startsWith("updateMask.fieldPaths=") }
                        .map { URLDecoder.decode(it.substringAfter('='), "UTF-8") }
                        .takeIf { it.isNotEmpty() }
                    val sent = Json.parseToJsonElement(body).jsonObject["fields"]?.jsonObject ?: JsonObject(emptyMap())
                    synchronized(masks) { masks += mask }
                    docs[rel] = if (mask == null) sent else applyMask(docs[rel] ?: JsonObject(emptyMap()), sent, mask)
                    200 to docJson(rel, docs.getValue(rel)).toString()
                }
                else -> 405 to "{}"
            }
            val bytes = out.encodeToByteArray()
            ex.sendResponseHeaders(status, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        JvmFirestoreFixtures.restTransport = RestTestTransport(
            http = auntieHttpClient(requestTimeoutMs = 5_000),
            base = "http://127.0.0.1:${server.address.port}/v1/projects/p/databases/(default)/documents",
            token = "test-token",
        )
    }

    fun stop() {
        JvmFirestoreFixtures.clear()
        server.stop(0)
    }

    private fun docJson(path: String, fields: JsonObject) = buildJsonObject {
        put("name", "projects/p/databases/(default)/documents/$path")
        put("fields", fields)
    }

    /** Splits a Firestore field path on dots outside backticks and unquotes each segment. */
    private fun segments(path: String): List<String> {
        val out = mutableListOf<String>()
        val cur = StringBuilder()
        var quoted = false
        var i = 0
        while (i < path.length) {
            val ch = path[i]
            when {
                quoted && ch == '\\' -> { cur.append(path[i + 1]); i++ }
                ch == '`' -> quoted = !quoted
                !quoted && ch == '.' -> { out += cur.toString(); cur.clear() }
                else -> cur.append(ch)
            }
            i++
        }
        out += cur.toString()
        return out
    }

    private fun mapFields(v: JsonObject?): JsonObject? = v?.get("mapValue")?.jsonObject?.get("fields")?.jsonObject

    /** Sets (or, when [value] is null, deletes) [path] in a `fields` object. */
    fun setAt(fields: JsonObject, path: List<String>, value: JsonObject?): JsonObject {
        val head = path.first()
        val m = fields.toMutableMap()
        if (path.size == 1) {
            if (value == null) m.remove(head) else m[head] = value
        } else {
            val child = mapFields(fields[head]?.jsonObject) ?: JsonObject(emptyMap())
            m[head] = buildJsonObject { put("mapValue", buildJsonObject { put("fields", setAt(child, path.drop(1), value)) }) }
        }
        return JsonObject(m)
    }

    fun getAt(fields: JsonObject?, path: List<String>): JsonObject? {
        val v = fields?.get(path.first())?.jsonObject ?: return null
        return if (path.size == 1) v else getAt(mapFields(v), path.drop(1))
    }

    private fun applyMask(stored: JsonObject, sent: JsonObject, mask: List<String>): JsonObject =
        mask.fold(stored) { acc, p -> segments(p).let { seg -> setAt(acc, seg, getAt(sent, seg)) } }

    companion object {
        fun ts(iso: String) = buildJsonObject { put("timestampValue", iso) }
        fun str(s: String) = buildJsonObject { put("stringValue", s) }
        fun bool(b: Boolean) = buildJsonObject { put("booleanValue", b) }
        fun map(vararg kv: Pair<String, JsonObject>) =
            buildJsonObject { put("mapValue", buildJsonObject { put("fields", JsonObject(kv.toMap())) }) }
    }
}
