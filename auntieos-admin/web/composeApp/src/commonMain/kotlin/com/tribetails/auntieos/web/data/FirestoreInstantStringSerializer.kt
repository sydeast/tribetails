package com.tribetails.auntieos.web.data

import com.tribetails.auntieos.web.observability.runCatchingCancellable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

/**
 * Decodes a Firestore "timestamp-ish" field into an ISO-8601 string.
 *
 * Fields written with `FieldValue.serverTimestamp()` (e.g. notifications.createdAt
 * / readAt / archivedAt) arrive over the web JS bridge — `JSON.stringify(doc.
 * data())` — as a `{"seconds":<long>,"nanoseconds":<int>}` OBJECT, not an ISO
 * string. But the models + UI treat these as ISO-8601 strings (NotificationsScreen
 * slices createdAt with relativeTime/datePrefix and sorts it lexically). A plain
 * `String` field therefore can't decode the object: kotlinx.serialization throws
 * and the whole document is dropped by the defensive collectionStream
 * (AUNTIEOS-ADMIN-13).
 *
 * This serializer normalizes either shape to an ISO-8601 string:
 *  - `{seconds,nanoseconds}` object -> `Instant.toString()` (e.g. 2026-06-27T17:07:24.579Z)
 *  - an already-ISO string          -> passed through unchanged
 *  - a bare number                  -> read as epoch millis, then ISO (#1065)
 *  - null / missing / unparseable   -> "" (matches the model defaults)
 *
 * It never throws on a value's shape, so a malformed timestamp blanks that one
 * field and the document still loads.
 */
@OptIn(ExperimentalTime::class)
object FirestoreInstantStringSerializer : KSerializer<String> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("FirestoreInstantString", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): String {
        val jsonDecoder = decoder as? JsonDecoder
            ?: return runCatchingCancellable { decoder.decodeString() }.getOrDefault("")
        return when (val el = jsonDecoder.decodeJsonElement()) {
            is JsonObject -> {
                val seconds = (el["seconds"] as? JsonPrimitive)?.longOrNull
                val nanos = (el["nanoseconds"] as? JsonPrimitive)?.longOrNull ?: 0L
                if (seconds == null) {
                    ""
                } else {
                    runCatchingCancellable { Instant.fromEpochSeconds(seconds, nanos).toString() }
                        .getOrDefault("")
                }
            }
            is JsonNull -> ""
            is JsonPrimitive -> primitiveToIso(el)
            else -> ""
        }
    }

    /** A string passes through; a number is epoch millis; anything else is blank. */
    private fun primitiveToIso(el: JsonPrimitive): String {
        if (el.isString) return el.content
        val millis = el.longOrNull
            ?: el.doubleOrNull?.takeIf { it.isFinite() }?.toLong()
            ?: return ""
        return runCatchingCancellable { Instant.fromEpochMilliseconds(millis).toString() }.getOrDefault("")
    }

    override fun serialize(encoder: Encoder, value: String) {
        encoder.encodeString(value)
    }
}
