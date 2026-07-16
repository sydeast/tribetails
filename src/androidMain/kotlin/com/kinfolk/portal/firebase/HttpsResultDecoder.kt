package com.kinfolk.portal.firebase

import dev.gitlive.firebase.functions.HttpsCallableResult

@Suppress("UNCHECKED_CAST")
actual fun decodeHttpsResult(result: HttpsCallableResult): Map<String, Any?> {
    // gitlive 2.x's typed `data<Map<String, Any?>>()` routes through
    // FirebaseDecoder which requires a contextual KSerializer for the target
    // type. None is registered, so the typed call throws SerializationException
    // at runtime — breaking every authenticated Cloud Function call on Android.
    //
    // Workaround: locate the underlying Firebase platform result via reflection
    // (search the wrapper's fields for any com.google.firebase.functions.*
    // instance), then invoke its native getData() (returns HashMap<String,
    // Object>) and convert recursively. Looking up by FQN prefix instead of
    // field name survives Kotlin compile-name mangling and gitlive bumps.
    val raw = findUnderlyingResult(result) ?: return emptyMap()
    val rawData: Any? = try {
        raw.javaClass.getMethod("getData").invoke(raw)
    } catch (_: Exception) {
        null
    }
    return anyToMap(rawData)
}

private fun findUnderlyingResult(wrapper: Any): Any? {
    // gitlive 1.x convention: a public `android` field. Try that first.
    try {
        val f = wrapper.javaClass.getDeclaredField("android").apply { isAccessible = true }
        val v = f.get(wrapper)
        if (v != null && v.javaClass.name.startsWith("com.google.firebase.functions")) return v
    } catch (_: Exception) {
        // fall through to broader scan
    }
    // Fallback: any declared field whose value is a Firebase platform result.
    for (f in wrapper.javaClass.declaredFields) {
        f.isAccessible = true
        val v = try { f.get(wrapper) } catch (_: Exception) { null } ?: continue
        if (v.javaClass.name.startsWith("com.google.firebase.functions")) return v
    }
    return null
}

@Suppress("UNCHECKED_CAST")
private fun anyToMap(v: Any?): Map<String, Any?> {
    if (v is Map<*, *>) {
        return v.entries.associate { (k, vv) -> k.toString() to convertValue(vv) }
    }
    return emptyMap()
}

@Suppress("UNCHECKED_CAST")
private fun convertValue(v: Any?): Any? = when (v) {
    null -> null
    is Map<*, *> -> v.entries.associate { (k, vv) -> k.toString() to convertValue(vv) }
    is List<*> -> v.map { convertValue(it) }
    is Array<*> -> v.map { convertValue(it) }
    is Number, is Boolean, is String -> v
    // Fail-loud on unknown types: stringify rather than silently null so callers
    // see something visible in the rendered payload during development.
    else -> v.toString()
}
