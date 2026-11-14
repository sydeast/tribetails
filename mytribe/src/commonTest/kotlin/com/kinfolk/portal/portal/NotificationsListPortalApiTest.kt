package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `listMyNotifications` and `markNotificationRead` on the portal Android app
 * (#1316): the wire shape decoded leniently, the unread badge count on
 * `getMyHome`, and the pure rule that says where a tapped row goes.
 */
class NotificationsListPortalApiTest {

    private fun row(
        id: String,
        targetType: String = "invoice",
        targetId: String = "inv-1",
        visitId: String? = null,
        batchId: String? = null,
        readAt: String? = null,
        createdAt: String? = "2026-11-01T12:00:00.000Z",
    ): JsonObject = buildJsonObject {
        put("id", id)
        put("key", "invoice.new")
        put("category", "invoice")
        put("title", "New invoice")
        put("description", "An invoice is ready.")
        put("actorName", "Auntie Sam")
        put("actorPhotoUrl", "https://cdn/sam.jpg")
        put("targetType", targetType)
        put("targetId", targetId)
        if (visitId == null) put("visitId", JsonNull) else put("visitId", visitId)
        if (batchId == null) put("batchId", JsonNull) else put("batchId", batchId)
        if (createdAt == null) put("createdAt", JsonNull) else put("createdAt", createdAt)
        if (readAt == null) put("readAt", JsonNull) else put("readAt", readAt)
    }

    @Test
    fun `decodes a page, newest first as sent, with the unread count and the cursor`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("listMyNotifications", buildJsonObject {
            put("items", buildJsonArray {
                add(row("n1"))
                add(row("n2", readAt = "2026-11-01T11:00:00.000Z"))
            })
            put("unreadCount", 7)
            put("hasMore", true)
            put("nextBefore", 1_761_998_400_000L)
        })

        val page = PortalApi(fake).listMyNotifications("fam-1", limit = 50)

        assertEquals(listOf("n1", "n2"), page.items.map { it.id })
        assertEquals(7, page.unreadCount)
        assertTrue(page.hasMore)
        assertEquals(1_761_998_400_000L, page.nextBefore)
        val first = page.items[0]
        assertEquals("New invoice", first.title)
        assertEquals("An invoice is ready.", first.description)
        assertEquals("Auntie Sam", first.actorName)
        // 2026-11-01T12:00:00Z and 11:00:00Z, as epoch millis.
        assertEquals(1_793_534_400_000L, first.createdAtMs)
        assertTrue(first.unread)
        assertNull(first.readAtMs)
        assertFalse(page.items[1].unread)
        assertEquals(1_793_530_800_000L, page.items[1].readAtMs)

        assertEquals("listMyNotifications", fake.calls[0].first)
        val sent = fake.calls[0].second!!
        assertEquals("fam-1", sent["kinfolkId"]!!.jsonPrimitive.content)
        assertEquals("50", sent["limit"]!!.jsonPrimitive.content)
        assertNull(sent["before"])
    }

    @Test
    fun `sends the cursor when paging, and nothing at all when nothing was given`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("listMyNotifications", buildJsonObject {
            put("items", buildJsonArray {})
            put("unreadCount", 0)
            put("hasMore", false)
            put("nextBefore", JsonNull)
        })
        val api = PortalApi(fake)
        api.listMyNotifications("fam-1", limit = 50, before = 1_700_000_000_000L)
        assertEquals("1700000000000", fake.calls[0].second!!["before"]!!.jsonPrimitive.content)
        api.listMyNotifications()
        assertNull(fake.calls[1].second)
    }

    @Test
    fun `an old server or a sparse row degrades, never throws`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("listMyNotifications", buildJsonObject {
            put("items", buildJsonArray {
                add(buildJsonObject { put("id", "sparse") })
                add(buildJsonObject { put("title", "no id, dropped") })
                add(row("bad-time", createdAt = "yesterday-ish"))
            })
        })
        val page = PortalApi(fake).listMyNotifications("fam-1")
        assertEquals(listOf("sparse", "bad-time"), page.items.map { it.id })
        val sparse = page.items[0]
        assertEquals("", sparse.title)
        assertEquals("", sparse.targetType)
        assertNull(sparse.createdAtMs)
        assertTrue(sparse.unread)
        // No readable time is no time, never the epoch.
        assertNull(page.items[1].createdAtMs)
        // No count from the server: count what arrived.
        assertEquals(2, page.unreadCount)
        assertFalse(page.hasMore)
        assertNull(page.nextBefore)
    }

    @Test
    fun `markNotificationRead names the row by notificationId`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("markNotificationRead", buildJsonObject { put("ok", true) })
        PortalApi(fake).markNotificationRead("n-1")
        assertEquals("markNotificationRead", fake.calls[0].first)
        assertEquals("n-1", fake.calls[0].second!!["notificationId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `getMyHome decodes unreadNotifications, and reads a missing field as 0`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyHome", buildJsonObject {
            put("kinfolkId", "fam-1")
            put("displayName", "The Foster")
            put("unreadNotifications", 4)
        })
        assertEquals(4, PortalApi(fake).getMyHome("fam-1").unreadNotifications)

        val old = FakeFunctionsClient()
        old.stub("getMyHome", buildJsonObject {
            put("kinfolkId", "fam-1")
            put("displayName", "The Foster")
        })
        assertEquals(0, PortalApi(old).getMyHome("fam-1").unreadNotifications)
    }

    private fun item(
        targetType: String,
        targetId: String = "",
        visitId: String? = null,
        batchId: String? = null,
    ) = decodeNotificationItem(row("x", targetType = targetType, targetId = targetId, visitId = visitId, batchId = batchId))!!

    @Test
    fun `a per-visit booking row opens the visit, with its batch for the detail screen`() {
        assertEquals(
            NotificationTarget.Visit("visit-1", "batch-1"),
            notificationTargetOf(item("booking", targetId = "visit-1", visitId = "visit-1", batchId = "batch-1")),
        )
        assertEquals(
            NotificationTarget.Visit("visit-1", null),
            notificationTargetOf(item("booking", targetId = "visit-1", visitId = "visit-1")),
        )
    }

    @Test
    fun `a whole-request booking row opens the request, whose id is the batch not a visit`() {
        assertEquals(
            NotificationTarget.BookingRequest("batch-2"),
            notificationTargetOf(item("booking", targetId = "batch-2", batchId = "batch-2")),
        )
    }

    @Test
    fun `a booking row this client cannot place lands on Schedule rather than a visit that says not found`() {
        assertEquals(NotificationTarget.Schedule, notificationTargetOf(item("booking", targetId = "something")))
        // #1874: a reply from the office opens Messages.
        assertEquals(NotificationTarget.Messages, notificationTargetOf(item("conversation", targetId = "fam1")))
        assertEquals(NotificationTarget.Schedule, notificationTargetOf(item("booking", targetId = "x", visitId = "  ")))
    }

    @Test
    fun `invoice and kintale rows open by targetId, household and unresolved rows open nothing`() {
        assertEquals(NotificationTarget.Invoice("inv-9"), notificationTargetOf(item("invoice", targetId = "inv-9")))
        assertEquals(NotificationTarget.KinTale("tale-2"), notificationTargetOf(item("kintale", targetId = "tale-2")))
        assertEquals(NotificationTarget.None, notificationTargetOf(item("kinfolk", targetId = "fam-1")))
        assertEquals(NotificationTarget.None, notificationTargetOf(item("", targetId = "")))
        assertEquals(NotificationTarget.None, notificationTargetOf(item("invoice", targetId = "")))
        assertEquals(NotificationTarget.None, notificationTargetOf(item("something-new", targetId = "z")))
    }

    @Test
    fun `a Kin row opens the Kin, or the Kin tab when it names none (1913)`() {
        assertEquals(NotificationTarget.Kin("kin-2"), notificationTargetOf(item("kin", targetId = "kin-2")))
        assertEquals(NotificationTarget.KinList, notificationTargetOf(item("kin", targetId = " ")))
    }
    @Test
    fun `a KinTale row with no id opens the KinTales tab, and a profile row opens Tribe (1898)`() {
        assertEquals(NotificationTarget.KinTales, notificationTargetOf(item("kintale", targetId = "")))
        assertEquals(NotificationTarget.Household, notificationTargetOf(item("household", targetId = "")))
    }
    @Test
    fun `reads the office note off the card detail, and none when it wrote none (2030)`() {
        val withNote = buildJsonObject {
            row("n1").forEach { (k, v) -> put(k, v) }
            put("detail", buildJsonObject { put("householdNote", "  Booked. Bring the spare key.  "); put("kinName", "Rex") })
        }
        assertEquals("Booked. Bring the spare key.", decodeNotificationItem(withNote)?.householdNote)
        val blank = buildJsonObject {
            row("n2").forEach { (k, v) -> put(k, v) }
            put("detail", buildJsonObject { put("householdNote", "   ") })
        }
        assertNull(decodeNotificationItem(blank)?.householdNote)
        assertNull(decodeNotificationItem(row("n3"))?.householdNote)
    }
}
