package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.NotificationEntry
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

/**
 * AUNTIEOS-ADMIN-13 regression. Notification docs stamp createdAt/readAt/
 * archivedAt with FieldValue.serverTimestamp(), which arrives over the web JS
 * bridge (JSON.stringify of doc.data()) as a `{seconds,nanoseconds}` object, not
 * an ISO string. The model must still decode (so the defensive collectionStream
 * doesn't drop the doc) and must expose these fields as ISO-8601 strings that the
 * UI can slice (relativeTime/datePrefix) and sort lexically.
 */
@OptIn(ExperimentalTime::class)
class NotificationTimestampDecodeTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    @Test
    fun decodes_firestore_timestamp_object_into_iso_createdAt() {
        val raw =
            """{"_id":"n1","key":"kincare.booking.confirm","recipientUid":"u1","createdAt":{"seconds":1781199035,"nanoseconds":579000000}}"""

        val entry = json.decodeFromString<NotificationEntry>(raw)

        assertEquals("n1", entry._id)
        assertEquals(
            Instant.fromEpochSeconds(1781199035L, 579_000_000L).toString(),
            entry.createdAt,
        )
        assertTrue(entry.createdAt.contains("T") && entry.createdAt.endsWith("Z"))
    }

    @Test
    fun passes_through_existing_iso_string_createdAt() {
        val raw = """{"_id":"n2","createdAt":"2026-06-27T12:00:00.000Z"}"""
        val entry = json.decodeFromString<NotificationEntry>(raw)
        assertEquals("2026-06-27T12:00:00.000Z", entry.createdAt)
    }

    @Test
    fun decodes_timestamp_object_readAt_and_archivedAt() {
        val raw =
            """{"_id":"n3","readAt":{"seconds":1781199035,"nanoseconds":0},"archivedAt":{"seconds":1781199035,"nanoseconds":0}}"""
        val entry = json.decodeFromString<NotificationEntry>(raw)
        assertTrue(entry.isRead, "readAt object should decode to a non-blank ISO string")
        assertTrue(entry.isArchived, "archivedAt object should decode to a non-blank ISO string")
    }

    // #1065: a bare number used to pass through as its raw digits, which the UI
    // then sliced as if it were ISO. Epoch millis now become the same ISO string.
    @Test
    fun epoch_millis_number_createdAt_becomes_iso() {
        val iso = "2026-06-27T17:07:24.579Z"
        val ms = Instant.parse(iso).toEpochMilliseconds()
        assertEquals(iso, json.decodeFromString<NotificationEntry>("""{"_id":"n5","createdAt":$ms}""").createdAt)
        assertEquals(iso, json.decodeFromString<NotificationEntry>("""{"_id":"n6","createdAt":$ms.0}""").createdAt)
    }

    @Test
    fun malformed_timestamps_decode_blank_without_dropping_the_row() {
        for (bad in listOf("true", """{"seconds":"x"}""", "[1,2]", "\"\"", "1e400")) {
            val entry = json.decodeFromString<NotificationEntry>("""{"_id":"n7","key":"k","createdAt":$bad,"readAt":$bad}""")
            assertEquals("", entry.createdAt, "createdAt=$bad")
            assertEquals("", entry.readAt, "readAt=$bad")
            assertEquals("k", entry.key)
        }
    }

    @Test
    fun missing_timestamps_default_to_blank() {
        val raw = """{"_id":"n4","key":"x"}"""
        val entry = json.decodeFromString<NotificationEntry>(raw)
        assertEquals("", entry.createdAt)
        assertEquals("", entry.readAt)
        assertEquals(false, entry.isRead)
    }
}
