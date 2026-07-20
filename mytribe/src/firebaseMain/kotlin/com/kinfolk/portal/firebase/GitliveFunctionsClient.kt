package com.kinfolk.portal.firebase

import dev.gitlive.firebase.Firebase
import dev.gitlive.firebase.functions.functions
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Gitlive 2.x routes `httpsCallable.invoke()` + `result.data<T>()` through its
 * own `FirebaseEncoder`/`FirebaseDecoder`. Those are NOT `JsonEncoder` — so
 * kotlinx `JsonObject.serializer()` (type-locked to JSON format) throws
 * `IllegalStateException: This serializer can be used only with Json format.
 * Expected Encoder to be JsonEncoder, got class FirebaseEncoder`.
 *
 * Workaround: marshal kotlinx `JsonObject` ⇄ plain `Map<String, Any?>` before
 * crossing the gitlive serialization boundary. FirebaseEncoder handles maps,
 * lists, primitives natively — no kotlinx JSON-specific encoder required.
 */
class GitliveFunctionsClient : FunctionsClient {
    override suspend fun call(name: String, payload: JsonObject?): JsonObject {
        println("[Fns] call() name=$name payloadPresent=${payload != null}")
        return try {
            val fn = Firebase.functions.httpsCallable(name)
            val payloadMap: Map<String, Any?> = payload?.let { jsonObjectToMap(it) } ?: emptyMap()
            val result = fn.invoke(payloadMap)
            val dataMap = decodeHttpsResult(result)
            val data = mapToJsonObject(dataMap)
            println("[Fns] call() name=$name OK keys=${data.keys}")
            data
        } catch (t: Throwable) {
            println("[Fns] call() name=$name THREW ${t::class.simpleName}: ${t.message}")
            throw t
        }
    }
}

private fun jsonObjectToMap(obj: JsonObject): Map<String, Any?> =
    obj.mapValues { (_, v) -> jsonElementToAny(v) }

private fun jsonElementToAny(el: JsonElement): Any? = when (el) {
    is JsonNull -> null
    is JsonPrimitive -> jsonPrimitiveToAny(el)
    is JsonObject -> jsonObjectToMap(el)
    is JsonArray -> el.map { jsonElementToAny(it) }
}

/** JS Number.MAX_SAFE_INTEGER — longs inside this range convert to Double losslessly. */
private const val MAX_SAFE_INTEGER = 9007199254740991L

private fun jsonPrimitiveToAny(p: JsonPrimitive): Any? {
    if (p is JsonNull) return null
    if (p.isString) return p.content
    p.booleanOrNull?.let { return it }
    // Kotlin/JS Long is a wrapper CLASS, not a JS number: passing it into a
    // callable payload serializes as an empty object and the backend's Zod
    // schema rejects it ("expected number, received object" — hit live on
    // requestBooking.startTimeMs/priceCents, 2026-07-10). Safe-integer longs
    // (every ms timestamp and cent amount) go out as Double, which is lossless
    // in that range and serializes as a plain JSON number on every target.
    p.longOrNull?.let {
        return if (it in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER) it.toDouble() else it
    }
    p.doubleOrNull?.let { return it }
    return p.content
}

private fun mapToJsonObject(map: Map<String, Any?>): JsonObject = buildJsonObject {
    for ((k, v) in map) put(k, anyToJsonElement(v))
}

private fun anyToJsonElement(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Map<*, *> -> {
        @Suppress("UNCHECKED_CAST")
        mapToJsonObject(value as Map<String, Any?>)
    }
    is List<*> -> kotlinx.serialization.json.JsonArray(value.map { anyToJsonElement(it) })
    else -> JsonPrimitive(value.toString())
}
