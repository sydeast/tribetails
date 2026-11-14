@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.notifications

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.firebase.FunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What a household sees on the notifications list behind the bell (#1316), and
 * what a tap does: marks the row read (the row and the bell count at once, the
 * server told) and opens the thing the row is about.
 */
class NotificationsListScreenTest {

    private val now = 1_793_534_400_000L // 2026-11-01T12:00:00Z

    private fun row(
        id: String,
        title: String,
        description: String = "",
        targetType: String = "invoice",
        targetId: String = "inv-1",
        visitId: String? = null,
        batchId: String? = null,
        read: Boolean = false,
        minutesAgo: Long = 5,
    ): JsonObject = buildJsonObject {
        put("id", id)
        put("key", "k.$id")
        put("category", "c")
        put("title", title)
        put("description", description)
        put("actorName", "")
        put("actorPhotoUrl", "")
        put("targetType", targetType)
        put("targetId", targetId)
        if (visitId == null) put("visitId", JsonNull) else put("visitId", visitId)
        if (batchId == null) put("batchId", JsonNull) else put("batchId", batchId)
        put("createdAt", iso(now - minutesAgo * 60_000L))
        if (read) put("readAt", iso(now - 60_000L)) else put("readAt", JsonNull)
    }

    private fun iso(ms: Long): String = kotlin.time.Instant.fromEpochMilliseconds(ms).toString()

    private fun page(rows: List<JsonObject>, unreadCount: Int? = null, hasMore: Boolean = false, nextBefore: Long? = null): JsonObject =
        buildJsonObject {
            put("items", buildJsonArray { rows.forEach { add(it) } })
            put("unreadCount", unreadCount ?: rows.count { it["readAt"] == JsonNull })
            put("hasMore", hasMore)
            if (nextBefore == null) put("nextBefore", JsonNull) else put("nextBefore", nextBefore)
        }

    // Distinct ages, so each time label names exactly one row.
    private val rows = listOf(
        row("n-visit", "Visit confirmed", "Your visit is on the calendar.", targetType = "booking", targetId = "visit-1", visitId = "visit-1", batchId = "batch-1", minutesAgo = 5),
        row("n-batch", "Booking requested", "We got your request.", targetType = "booking", targetId = "batch-2", batchId = "batch-2", minutesAgo = 120),
        row("n-invoice", "New invoice", targetType = "invoice", targetId = "inv-9", read = true, minutesAgo = 180),
        row("n-tale", "New KinTale", targetType = "kintale", targetId = "tale-2", minutesAgo = 2 * 24 * 60),
        row("n-kinfolk", "Profile updated", targetType = "kinfolk", targetId = "fam-1", minutesAgo = 10),
    )

    private class Opened {
        var visit: Pair<String, String?>? = null
        var request: String? = null
        var schedule = 0
        var invoice: String? = null
        var tale: String? = null
        var tales = 0
        var kin: String? = null
        var kinList = 0
        var tribe = 0
        val counts = mutableListOf<Int>()
    }

    @Composable
    private fun Screen(fake: FakeFunctionsClient, opened: Opened) {
        NotificationsListScreen(
            kinfolkId = "fam-1",
            portalApi = PortalApi(fake),
            onOpenVisit = { v, b -> opened.visit = v to b },
            onOpenBookingRequest = { opened.request = it },
            onOpenSchedule = { opened.schedule += 1 },
            onOpenInvoice = { opened.invoice = it },
            onOpenKinTale = { opened.tale = it },
            onOpenKinTales = { opened.tales += 1 },
            onOpenKin = { opened.kin = it },
            onOpenKinList = { opened.kinList += 1 },
            onOpenTribe = { opened.tribe += 1 },
            onUnreadCount = { opened.counts += it },
            nowMs = { now },
        )
    }

    private fun stubbed(fake: FakeFunctionsClient = FakeFunctionsClient()): FakeFunctionsClient {
        fake.stub("listMyNotifications", page(rows))
        fake.stub("markNotificationRead", buildJsonObject { put("ok", true) })
        return fake
    }

    @Test
    fun rendersEveryRowWithTitleDescriptionAndTime_andReportsTheServersUnreadCount() = runComposeUiTest {
        val opened = Opened()
        setThemedContent { Screen(stubbed(), opened) }
        waitForIdle()

        onNodeWithText("Notifications").assertIsDisplayed()
        onNodeWithText("Visit confirmed").assertExists()
        onNodeWithText("Your visit is on the calendar.").assertExists()
        onNodeWithText("Booking requested").assertExists()
        onNodeWithText("New invoice").assertExists()
        onNodeWithText("5m ago").assertExists()
        onNodeWithText("2h ago").assertExists()
        onNodeWithText("3h ago").assertExists()
        onNodeWithText("2d ago").assertExists()
        onNodeWithText("10m ago").assertExists()
        assertEquals(listOf(4), opened.counts)
    }

    @Test
    fun marksUnreadRows_andLeavesReadRowsPlain() = runComposeUiTest {
        setThemedContent { Screen(stubbed(), Opened()) }
        waitForIdle()
        onNodeWithTag("unread-n-visit", useUnmergedTree = true).assertExists()
        onNodeWithTag("read-n-invoice", useUnmergedTree = true).assertExists()
        onNodeWithTag("unread-n-invoice", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun showsALoadingCueWhileTheReadIsOut() = runComposeUiTest {
        // A client that never answers, so the screen stays in its wait.
        val hanging = object : FunctionsClient {
            override suspend fun call(name: String, payload: JsonObject?): JsonObject = awaitCancellation()
        }
        setThemedContent {
            NotificationsListScreen(kinfolkId = "fam-1", portalApi = PortalApi(hanging), nowMs = { now })
        }
        waitForIdle()
        onNodeWithTag("notificationsLoading").assertExists()
        onNodeWithText("Loading your notifications…").assertExists()
        onNodeWithTag("notificationsEmpty").assertDoesNotExist()
    }

    @Test
    fun aFailedLoadSaysWhy_neverABlankCard() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("listMyNotifications", IllegalStateException("notifications unavailable"))
        setThemedContent { Screen(fake, Opened()) }
        waitForIdle()
        onNodeWithTag("notificationsError").assertExists()
        onNodeWithText("notifications unavailable").assertExists()
        onNodeWithTag("notificationsEmpty").assertDoesNotExist()
    }

    @Test
    fun saysSoInOneLineWhenThereIsNothingYet() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("listMyNotifications", page(emptyList()))
        setThemedContent { Screen(fake, Opened()) }
        waitForIdle()
        onNodeWithTag("notificationsEmpty").assertExists()
        onNodeWithText("No notifications yet.").assertExists()
    }

    @Test
    fun tapMarksTheRowRead_tellsTheServer_dropsTheCount_andOpensTheVisit() = runComposeUiTest {
        val fake = stubbed()
        val opened = Opened()
        setThemedContent { Screen(fake, opened) }
        waitForIdle()

        onNodeWithTag("notificationRow-n-visit").performClick()
        waitForIdle()

        onNodeWithTag("read-n-visit", useUnmergedTree = true).assertExists()
        onNodeWithTag("unread-n-visit", useUnmergedTree = true).assertDoesNotExist()
        val mark = fake.calls.first { it.first == "markNotificationRead" }
        assertEquals("n-visit", mark.second!!["notificationId"]!!.jsonPrimitive.content)
        assertEquals(listOf(4, 3), opened.counts)
        assertEquals("visit-1" to "batch-1", opened.visit)
    }

    @Test
    fun aWholeRequestRowOpensTheBookingRequest_notAVisit() = runComposeUiTest {
        val opened = Opened()
        setThemedContent { Screen(stubbed(), opened) }
        waitForIdle()
        onNodeWithTag("notificationRow-n-batch").performClick()
        waitForIdle()
        assertEquals("batch-2", opened.request)
        assertNull(opened.visit)
        assertEquals(0, opened.schedule)
    }

    @Test
    fun aReadRowOpensItsInvoiceWithoutBeingMarkedAgain() = runComposeUiTest {
        val fake = stubbed()
        val opened = Opened()
        setThemedContent { Screen(fake, opened) }
        waitForIdle()
        onNodeWithTag("notificationRow-n-invoice").performClick()
        waitForIdle()
        assertEquals("inv-9", opened.invoice)
        assertTrue(fake.calls.none { it.first == "markNotificationRead" })
        assertEquals(listOf(4), opened.counts)
    }

    @Test
    fun aTaleRowOpensTheKinTalesTabOnThatTale_andAHouseholdRowOnlyMarksRead() = runComposeUiTest {
        val fake = stubbed()
        val opened = Opened()
        setThemedContent { Screen(fake, opened) }
        waitForIdle()
        onNodeWithTag("notificationRow-n-tale").performClick()
        waitForIdle()
        assertEquals("tale-2", opened.tale)

        onNodeWithTag("notificationRow-n-kinfolk").performClick()
        waitForIdle()
        assertEquals(2, fake.calls.count { it.first == "markNotificationRead" })
        assertNull(opened.invoice)
        assertNull(opened.visit)
        assertEquals(0, opened.schedule)
        assertEquals(listOf(4, 3, 2), opened.counts)
    }

    @Test
    fun offersOlderRows_andAsksWithTheCursor() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubSequence(
            "listMyNotifications",
            page(listOf(rows[0]), unreadCount = 1, hasMore = true, nextBefore = 1_700_000_000_000L),
            page(listOf(rows[3]), unreadCount = 1),
        )
        setThemedContent { Screen(fake, Opened()) }
        waitForIdle()
        onNodeWithTag("notificationsOlder").assertExists()
        onNodeWithTag("notificationsOlder").performClick()
        waitForIdle()
        val second = fake.calls.filter { it.first == "listMyNotifications" }[1]
        assertEquals("1700000000000", second.second!!["before"]!!.jsonPrimitive.content)
        onNodeWithText("New KinTale").assertExists()
        onNodeWithTag("notificationsOlder").assertDoesNotExist()
    }
    // #1831, #1898, #1913: each notice says what happened and opens what it is about.
    private val notices = listOf(
        row("n-arrived", "Your Auntie has arrived", "Drop-in visit for Rex on Tue, Nov 17 at 9:00 AM", targetType = "booking", targetId = "v7", visitId = "v7", batchId = "b7", minutesAgo = 1),
        row("n-comments", "New comment on your KinTale", "Jamie and Sam commented on 2 KinTales", targetType = "kintale", targetId = "", minutesAgo = 3),
        row("n-kin", "Your Kin removal request was declined", "Mochi is staying on your profile", targetType = "kin", targetId = "kin-2", minutesAgo = 7),
        row("n-gone", "A Kin you asked to remove was removed", "Pip is no longer on your profile", targetType = "kin", targetId = "", minutesAgo = 9),
        row("n-profile", "Your profile was updated", "", targetType = "household", targetId = "", minutesAgo = 11),
    )
    private fun stubbedNotices(): FakeFunctionsClient {
        val fake = FakeFunctionsClient()
        fake.stub("listMyNotifications", page(notices))
        fake.stub("markNotificationRead", buildJsonObject { put("ok", true) })
        return fake
    }
    @Test
    fun eachNoticeShowsItsContentLine_andARowWithNoFactsShowsItsTitleAlone() = runComposeUiTest {
        setThemedContent { Screen(stubbedNotices(), Opened()) }
        waitForIdle()
        onNodeWithText("Drop-in visit for Rex on Tue, Nov 17 at 9:00 AM").assertIsDisplayed()
        onNodeWithText("Mochi is staying on your profile").assertIsDisplayed()
        onNodeWithText("Your profile was updated").assertIsDisplayed()
        // The row is one clickable node, so its parts sit in the unmerged tree.
        onNodeWithTag("notificationLine-n-arrived", useUnmergedTree = true).assertIsDisplayed()
        onNodeWithTag("notificationLine-n-profile", useUnmergedTree = true).assertDoesNotExist()
    }
    @Test
    fun aKinNoticeOpensThatKin_andARemovedKinOpensTheKinTab() = runComposeUiTest {
        val opened = Opened()
        setThemedContent { Screen(stubbedNotices(), opened) }
        waitForIdle()
        onNodeWithTag("notificationRow-n-kin").performClick()
        waitForIdle()
        assertEquals("kin-2", opened.kin)
        onNodeWithTag("notificationRow-n-gone").performClick()
        waitForIdle()
        assertEquals(1, opened.kinList)
    }
    @Test
    fun commentsAcrossTalesOpenTheKinTalesTab_andAProfileChangeOpensTribe() = runComposeUiTest {
        val opened = Opened()
        val fake = stubbedNotices()
        setThemedContent { Screen(fake, opened) }
        waitForIdle()
        onNodeWithTag("notificationRow-n-comments").performClick()
        waitForIdle()
        assertEquals(1, opened.tales)
        assertNull(opened.tale)
        onNodeWithTag("notificationRow-n-profile").performClick()
        waitForIdle()
        assertEquals(1, opened.tribe)
        assertEquals(2, fake.calls.count { it.first == "markNotificationRead" })
    }
    @Test
    fun theArrivalNoticeOpensItsVisit() = runComposeUiTest {
        val opened = Opened()
        setThemedContent { Screen(stubbedNotices(), opened) }
        waitForIdle()
        onNodeWithTag("notificationRow-n-arrived").performClick()
        waitForIdle()
        assertEquals("v7" to "b7", opened.visit)
    }
}
