package com.kinfolk.portal.firebase

import com.google.firebase.functions.FirebaseFunctions
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Android-native HTTPS-callable client.
 *
 * Bypasses gitlive 2.x entirely for the call path. Gitlive routes
 * `HttpsCallableReference.invoke(Any?)` and `result.data<T>()` through its own
 * `FirebaseEncoder`/`FirebaseDecoder`, which require a contextual
 * `KSerializer<T>` for every payload + result type. Map<String, Any?> needs a
 * serializer for kotlin.Any — none is registered, and the SEND side throws
 *   SerializationException: Serializer for class 'Any' is not found
 * on every authenticated call (login → loading-your-tribe → infinite spin).
 *
 * The native Google SDK accepts a plain HashMap on `call(Object data)` and
 * returns a `HashMap<String, Object>` from `getData()`. No serializer layer.
 *
 * Receive-side reflection workaround (HttpsResultDecoder.kt) is now unused on
 * Android, but kept for the jsMain path which still uses GitliveFunctionsClient.
 */
class NativeAndroidFunctionsClient : FunctionsClient {
    override suspend fun call(name: String, payload: JsonObject?): JsonObject {
        val payloadMap: Map<String, Any?> =
            payload?.let { jsonObjectToMap(it) } ?: emptyMap()
        val result = FirebaseFunctions.getInstance()
            .getHttpsCallable(name)
            .call(payloadMap)
            .await()
        // `result.data` synthetic property resolves to a private field on
        // firebase-functions 21.x (visibility shadows the public getter from
        // Kotlin). Call getData() explicitly via reflection — survives that
        // visibility quirk and future library renames.
        val raw: Any? = try {
            result.javaClass.getMethod("getData").invoke(result)
        } catch (_: Exception) {
            null
        }
        @Suppress("UNCHECKED_CAST")
        val map = raw as? Map<String, Any?> ?: emptyMap()
        return mapToJsonObject(map)
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

private fun jsonPrimitiveToAny(p: JsonPrimitive): Any? {
    if (p is JsonNull) return null
    if (p.isString) return p.content
    p.booleanOrNull?.let { return it }
    p.longOrNull?.let { return it }
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
    is List<*> -> JsonArray(value.map { anyToJsonElement(it) })
    is Array<*> -> JsonArray(value.map { anyToJsonElement(it) })
    else -> JsonPrimitive(value.toString())
}
