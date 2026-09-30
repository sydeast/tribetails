package com.tribetails.auntieos.data.repository

import com.google.firebase.Timestamp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Date

/**
 * #1065 / AUNTIEOS-ADMIN-1N: `notifications/{id}.createdAt` is a server
 * Timestamp on every MyTribe writer, and `toObjects` into a String field threw
 * and blanked the whole inbox. [decodeNotificationEntry] must accept every
 * shape the field has carried and never throw on one bad doc.
 */
class NotificationEntryDecodeTest {

    private val epochMs = 1_782_580_044_579L // 2026-06-27T17:07:24.579Z
    private val iso = "2026-06-27T17:07:24.579Z"

    private fun doc(createdAt: Any?, extra: Map<String, Any?> = emptyMap()): Map<String, Any?> =
        mapOf(
            "key" to "kincare.booking.confirm",
            "recipientUid" to "admin-1",
            "title" to "Visit confirmed",
            "createdAt" to createdAt,
        ) + extra

    @Test fun `createdAt as Firestore Timestamp normalises to ISO UTC`() {
        val d = decodeNotificationEntry("n1", doc(Timestamp(Date(epochMs))))
        assertEquals(iso, d.entry.createdAt)
        assertEquals("n1", d.entry.id)
        assertEquals("Visit confirmed", d.entry.title)
        assertTrue(d.problems.isEmpty())
    }

    @Test fun `createdAt as Timestamp keeps sub-millisecond nanos`() {
        val d = decodeNotificationEntry("n1", doc(Timestamp(1_782_580_044L, 579_000_001)))
        assertEquals("2026-06-27T17:07:24.579000001Z", d.entry.createdAt)
    }

    @Test fun `createdAt as java util Date normalises to ISO UTC`() {
        val d = decodeNotificationEntry("n1", doc(Date(epochMs)))
        assertEquals(iso, d.entry.createdAt)
        assertTrue(d.problems.isEmpty())
    }

    @Test fun `createdAt as epoch millis Number normalises to ISO UTC`() {
        assertEquals(iso, decodeNotificationEntry("n1", doc(epochMs)).entry.createdAt)
        assertEquals(iso, decodeNotificationEntry("n1", doc(epochMs.toDouble())).entry.createdAt)
    }

    @Test fun `createdAt as ISO String passes through normalised`() {
        assertEquals(iso, decodeNotificationEntry("n1", doc(iso)).entry.createdAt)
        // An offset is converted to UTC so lexical sort in the UI stays chronological.
        assertEquals(iso, decodeNotificationEntry("n1", doc("2026-06-27T19:07:24.579+02:00")).entry.createdAt)
    }

    @Test fun `unparseable createdAt String degrades to blank and is reported`() {
        val d = decodeNotificationEntry("n1", doc("yesterday-ish"))
        assertEquals("", d.entry.createdAt)
        assertEquals("Visit confirmed", d.entry.title)
        assertEquals(listOf("createdAt:String(unparseable)"), d.problems)
    }

    @Test fun `missing createdAt degrades to blank and is reported`() {
        val d = decodeNotificationEntry("n1", doc(null))
        assertEquals("", d.entry.createdAt)
        assertEquals(listOf("createdAt:missing"), d.problems)
    }

    @Test fun `malformed doc with wrong-typed fields degrades instead of throwing`() {
        val d = decodeNotificationEntry(
            "bad",
            mapOf(
                "key" to 42,
                "title" to listOf("x"),
                "actorName" to null,
                "createdAt" to mapOf("seconds" to 1),
                "readAt" to true,
                "archivedAt" to Double.NaN,
                "data" to "not-a-map",
                "detail" to "not-a-map",
            ),
        )
        assertEquals("bad", d.entry.id)
        assertEquals("", d.entry.key)
        assertEquals("", d.entry.title)
        assertNull(d.entry.actorName)
        assertEquals("", d.entry.createdAt)
        assertNull(d.entry.readAt)
        assertNull(d.entry.archivedAt)
        assertTrue(d.entry.data.isEmpty())
        assertNull(d.entry.detail)
        assertEquals(
            listOf("createdAt:SingletonMap", "readAt:Boolean", "archivedAt:Number(non-finite)"),
            d.problems,
        )
    }

    @Test fun `readAt and archivedAt server Timestamps decode to ISO`() {
        val d = decodeNotificationEntry(
            "n1",
            doc(
                Timestamp(Date(epochMs)),
                mapOf("readAt" to Timestamp(Date(epochMs)), "archivedAt" to Timestamp(Date(epochMs))),
            ),
        )
        assertEquals(iso, d.entry.readAt)
        assertEquals(iso, d.entry.archivedAt)
    }

    @Test fun `unarchived doc writes archivedAt null and stays active`() {
        val d = decodeNotificationEntry("n1", doc(iso, mapOf("archivedAt" to null)))
        assertNull(d.entry.archivedAt)
        assertTrue(d.problems.isEmpty())
    }

    @Test fun `detail and data bag decode`() {
        val d = decodeNotificationEntry(
            "n1",
            doc(
                iso,
                mapOf(
                    "detail" to mapOf("kinfolkName" to "The Wrens", "amount" to 12),
                    "data" to mapOf("kinfolkId" to "kf-1", "count" to 3L),
                    "targetType" to "booking",
                    "targetId" to "bk-1",
                ),
            ),
        )
        assertEquals("The Wrens", d.entry.detail?.kinfolkName)
        assertEquals("", d.entry.detail?.amount)
        assertEquals(mapOf("kinfolkId" to "kf-1", "count" to 3L), d.entry.data)
        assertEquals("booking", d.entry.targetType)
        assertEquals("bk-1", d.entry.targetId)
    }
}
