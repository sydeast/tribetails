package com.kinfolk.portal.firebase

import dev.gitlive.firebase.functions.HttpsCallableResult

actual fun decodeHttpsResult(result: HttpsCallableResult): Map<String, Any?> {
    val d: dynamic = result.asDynamic()
    // gitlive 2.x wraps the underlying Firebase JS HttpsCallableResult in a
    // Kotlin/JS object with a MINIFIED single field (observed `dmk_1` 2026-05-18
    // but the name shifts every Kotlin compile). Structure-based probe:
    // walk the immediate properties and grab the first object that itself has
    // a `data` property — that's the underlying Firebase JS result.
    val raw: dynamic = findUnderlyingData(d) ?: return emptyMap()
    return dynamicToMap(raw)
}

private fun findUnderlyingData(d: dynamic): dynamic {
    // Direct .data first (covers any future gitlive version that exposes it).
    if (d.data != null && d.data != undefined && (js("typeof d.data") as String) == "object") {
        return d.data
    }
    val keys = (js("Object.keys(d)") as Array<String>)
    for (k in keys) {
        val v: dynamic = d[k]
        if (v == null || v == undefined) continue
        if ((js("typeof v") as String) != "object") continue
        val inner: dynamic = v.data
        if (inner != null && inner != undefined && (js("typeof inner") as String) == "object") {
            return inner
        }
    }
    return null
}

private fun dynamicToMap(obj: dynamic): Map<String, Any?> {
    if (obj == null || obj == undefined) return emptyMap()
    @Suppress("UNCHECKED_CAST")
    val keys = js("Object.keys(obj)") as Array<String>
    return keys.associate { key -> key to dynamicToAny(obj[key]) }
}

private fun dynamicToAny(v: dynamic): Any? {
    if (v == null || v == undefined) return null
    return when (js("typeof v") as String) {
        "boolean" -> v as Boolean
        "number" -> {
            val d = v as Double
            if (d == kotlin.math.floor(d) && !d.isInfinite()) d.toLong() else d
        }
        "string" -> v as String
        "object" -> if (js("Array.isArray(v)") as Boolean) {
            @Suppress("UNCHECKED_CAST")
            val arr = v as Array<dynamic>
            arr.map { dynamicToAny(it) }
        } else {
            dynamicToMap(v)
        }
        else -> null
    }
}
