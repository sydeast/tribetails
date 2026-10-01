package com.tribetails.auntieos.data.admin

import com.google.firebase.Timestamp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.util.Date

/**
 * #1065 (AUNTIEOS-ADMIN-1N): `getNotifications` decoded with
 * `QuerySnapshot.toObjects(NotificationEntry)`, whose `createdAt` is a String.
 * Every server writer stamps `createdAt: FieldValue.serverTimestamp()`, so the
 * reflection mapper threw on the first doc and the whole inbox failed to load.
 * `readAt` and `archivedAt` are server timestamps too, so a read or archived row
 * would have thrown the same way.
 *
 * [notificationEntryFromMap] takes every shape a timestamp field can arrive in
 * and normalises it to the ISO-8601 string the UI sorts and formats. A value it
 * cannot read degrades that one field, never the row and never the list.
 */
class NotificationEntryDecodeTest {

    private val iso = "2026-06-27T17:07:24.579Z"
    private val instant = Instant.parse(iso)
    private val millis = instant.toEpochMilli()

    private fun doc(createdAt: Any?): Map<String, Any?> = mapOf(
        "key" to "kincare.booking.confirm",
        "recipientUid" to "u1",
        "createdAt" to createdAt,
    )

    // ── createdAt: every shape normalises to the same ISO-8601 string ────────

    @Test fun `createdAt as a Firestore Timestamp becomes ISO`() {
        val e = notificationEntryFromMap("n1", doc(Timestamp(Date.from(instant))))
        assertEquals(iso, e.createdAt)
    }

    @Test fun `createdAt as a java Date becomes ISO`() {
        assertEquals(iso, notificationEntryFromMap("n1", doc(Date.from(instant))).createdAt)
    }

    @Test fun `createdAt as epoch millis Long becomes ISO`() {
        assertEquals(iso, notificationEntryFromMap("n1", doc(millis)).createdAt)
    }

    @Test fun `createdAt as epoch millis Double becomes ISO`() {
        assertEquals(iso, notificationEntryFromMap("n1", doc(millis.toDouble())).createdAt)
    }

    @Test fun `createdAt as an ISO string passes through`() {
        assertEquals(iso, notificationEntryFromMap("n1", doc(iso)).createdAt)
    }

    @Test fun `createdAt absent or null is blank`() {
        assertEquals("", notificationEntryFromMap("n1", mapOf("key" to "k")).createdAt)
        assertEquals("", notificationEntryFromMap("n1", doc(null)).createdAt)
    }

    @Test fun `createdAt malformed is blank and the rest of the row survives`() {
        for (bad in listOf<Any>(mapOf("seconds" to "x"), true, listOf(1, 2), Double.NaN, "   ")) {
            val e = notificationEntryFromMap("n1", doc(bad))
            assertEquals("bad=$bad", "", e.createdAt)
            assertEquals("kincare.booking.confirm", e.key)
            assertEquals("u1", e.recipientUid)
        }
    }

    // ── readAt / archivedAt: server timestamps, null and absent all mean something ──

    @Test fun `readAt Timestamp is ISO, absent is null`() {
        val read = notificationEntryFromMap("n1", doc(iso) + ("readAt" to Timestamp(Date.from(instant))))
        assertEquals(iso, read.readAt)
        assertNull(notificationEntryFromMap("n1", doc(iso)).readAt)
    }

    @Test fun `archivedAt Timestamp is ISO, null and absent are null`() {
        val filed = notificationEntryFromMap("n1", doc(iso) + ("archivedAt" to Timestamp(Date.from(instant))))
        assertEquals(iso, filed.archivedAt)
        // unarchiveNotification merge-writes an explicit null.
        assertNull(notificationEntryFromMap("n1", doc(iso) + ("archivedAt" to null)).archivedAt)
        assertNull(notificationEntryFromMap("n1", doc(iso)).archivedAt)
    }

    @Test fun `malformed readAt and archivedAt read as unset`() {
        val e = notificationEntryFromMap("n1", doc(iso) + ("readAt" to true) + ("archivedAt" to mapOf("a" to 1)))
        assertNull(e.readAt)
        assertNull(e.archivedAt)
    }

    // ── the rest of the fields toObjects() used to fill ──────────────────────

    @Test fun `every field maps, and the doc id becomes id`() {
        val e = notificationEntryFromMap(
            "n42",
            mapOf(
                "key" to "invoice.new",
                "category" to "payments",
                "recipientUid" to "u1",
                "actorUid" to "a1",
                "title" to "New invoice",
                "description" to "An invoice was sent",
                "actorName" to "Auntie",
                "detail" to mapOf("kinfolkName" to "Smith", "amount" to 42.5, "notes" to null),
                "data" to mapOf("kinfolkId" to "k1", "n" to 3L),
                "createdAt" to Timestamp(Date.from(instant)),
                "targetType" to "invoice",
                "targetId" to "inv1",
            ),
        )
        assertEquals("n42", e.id)
        assertEquals("invoice.new", e.key)
        assertEquals("payments", e.category)
        assertEquals("u1", e.recipientUid)
        assertEquals("a1", e.actorUid)
        assertEquals("New invoice", e.title)
        assertEquals("An invoice was sent", e.description)
        assertEquals("Auntie", e.actorName)
        assertEquals("Smith", e.detail?.kinfolkName)
        assertEquals("42.5", e.detail?.amount)
        assertEquals("", e.detail?.notes)
        assertEquals(mapOf("kinfolkId" to "k1", "n" to 3L), e.data)
        assertEquals(iso, e.createdAt)
        assertEquals("invoice", e.targetType)
        assertEquals("inv1", e.targetId)
    }

    @Test fun `system rows keep a null actorName and no detail`() {
        val e = notificationEntryFromMap("n1", doc(iso) + ("actorName" to null) + ("actorUid" to null))
        assertNull(e.actorName)
        assertNull(e.actorUid)
        assertNull(e.detail)
        assertEquals(emptyMap<String, Any?>(), e.data)
    }

    // ── the list: one bad doc never takes the others down ────────────────────

    @Test fun `a malformed doc among good ones degrades only that row`() {
        val rows = decodeNotificationDocs(
            listOf(
                "a" to doc(Timestamp(Date.from(instant))),
                "b" to doc(mapOf("not" to "a time")) + ("detail" to "not a map") + ("data" to listOf(1)),
                "c" to doc(iso),
            ),
        )
        assertEquals(listOf("a", "b", "c"), rows.map { it.id })
        assertEquals(listOf(iso, "", iso), rows.map { it.createdAt })
        assertNull(rows[1].detail)
        assertEquals(emptyMap<String, Any?>(), rows[1].data)
    }

    @Test fun `a doc with no data is dropped and reported, the rest load`() {
        val dropped = mutableListOf<String>()
        val rows = decodeNotificationDocs(
            listOf("a" to doc(iso), "gone" to null, "c" to doc(millis)),
            onDropped = { id, _ -> dropped += id },
        )
        assertEquals(listOf("a", "c"), rows.map { it.id })
        assertEquals(listOf("gone"), dropped)
    }
}
