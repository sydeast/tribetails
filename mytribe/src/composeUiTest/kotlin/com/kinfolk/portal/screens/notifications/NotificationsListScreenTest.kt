@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.notifications

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.isSelected
import androidx.compose.ui.test.onAllNodesWithTag
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
    private fun Screen(fake: FakeFunctionsClient, opened: Opened, openedEntryId: String? = null) {
        NotificationsListScreen(
            openedEntryId = openedEntryId,
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

    // ---- opened at one entry by a tapped push (ruling 2026-11-14) ----
    @Test
    fun aPushThatOpensTheListAtAnEntryMarksThatRowAndNoOther() = runComposeUiTest {
        val opened = Opened()
        setThemedContent { Screen(stubbed(), opened, openedEntryId = "n-batch") }
        waitForIdle()
        onNodeWithTag("notificationRow-n-batch").assertIsSelected()
        onNodeWithTag("notificationRow-n-batch").assertIsDisplayed()
        assertEquals(1, onAllNodes(isSelected()).fetchSemanticsNodes().size)
        // The whole message is on the row.
        onNodeWithText("We got your request.").assertIsDisplayed()
        // Opening the list at an entry reads nothing and goes nowhere.
        onNodeWithTag("unread-n-batch", useUnmergedTree = true).assertExists()
        assertNull(opened.request)
        assertEquals(listOf(4), opened.counts)
    }
    @Test
    fun anEntryThatIsNotAmongTheHouseholdsRowsMarksNothing() = runComposeUiTest {
        val opened = Opened()
        setThemedContent { Screen(stubbed(), opened, openedEntryId = "another-households-entry") }
        waitForIdle()
        assertEquals(0, onAllNodes(isSelected()).fetchSemanticsNodes().size)
        onNodeWithText("Visit confirmed").assertExists()
        onNodeWithText("Booking requested").assertExists()
    }
    @Test
    fun withNoEntryNoRowIsMarked() = runComposeUiTest {
        setThemedContent { Screen(stubbed(), Opened()) }
        waitForIdle()
        assertEquals(0, onAllNodes(isSelected()).fetchSemanticsNodes().size)
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

    // ---- #1833: the list and the bell's live count ----
    @Test
    fun aTapTakesTheRowOffTheBellAtOnce() = runComposeUiTest {
        val locally = mutableListOf<String>()
        val refused = mutableListOf<String>()
        setThemedContent {
            NotificationsListScreen(
                kinfolkId = "fam-1",
                portalApi = PortalApi(stubbed()),
                onReadLocally = { locally += it },
                onReadRefused = { refused += it },
                nowMs = { now },
            )
        }
        waitForIdle()
        onNodeWithTag("notificationRow-n-visit").performClick()
        waitForIdle()
        assertEquals(listOf("n-visit"), locally)
        assertTrue(refused.isEmpty())
        // A row that was already read is not sent to the bell again.
        onNodeWithTag("notificationRow-n-invoice").performClick()
        waitForIdle()
        assertEquals(listOf("n-visit"), locally)
    }
    @Test
    fun aRefusedReadPutsTheRowBackOnTheBell() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("listMyNotifications", page(rows))
        fake.stubError("markNotificationRead", IllegalStateException("permission-denied"))
        val locally = mutableListOf<String>()
        val refused = mutableListOf<String>()
        setThemedContent {
            NotificationsListScreen(
                kinfolkId = "fam-1",
                portalApi = PortalApi(fake),
                onReadLocally = { locally += it },
                onReadRefused = { refused += it },
                nowMs = { now },
            )
        }
        waitForIdle()
        onNodeWithTag("notificationRow-n-tale").performClick()
        waitForIdle()
        assertEquals(listOf("n-tale"), locally)
        assertEquals(listOf("n-tale"), refused)
    }
    @Test
    fun aNoticeArrivingWhileTheListIsOpenIsListed_withoutLeavingTheScreen() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        val arrived = row("n-omw", "Your Auntie is on the way", minutesAgo = 0)
        fake.stubSequence("listMyNotifications", page(rows), page(listOf(arrived) + rows))
        val opened = Opened()
        var revision by androidx.compose.runtime.mutableStateOf(0)
        setThemedContent {
            NotificationsListScreen(
                kinfolkId = "fam-1",
                portalApi = PortalApi(fake),
                onUnreadCount = { opened.counts += it },
                liveRevision = revision,
                nowMs = { now },
            )
        }
        waitForIdle()
        onNodeWithText("Your Auntie is on the way").assertDoesNotExist()
        assertEquals(1, fake.calls.count { it.first == "listMyNotifications" })
        // The bell's listener saw a row arrive.
        revision = 1
        waitForIdle()
        onNodeWithText("Your Auntie is on the way").assertExists()
        onNodeWithTag("unread-n-omw", useUnmergedTree = true).assertExists()
        onNodeWithText("Visit confirmed").assertExists()
        assertEquals(2, fake.calls.count { it.first == "listMyNotifications" })
        assertEquals(listOf(4, 5), opened.counts)
    }
    @Test
    fun aReloadAfterShowOlderKeepsTheOlderPageAndItsCursor_andListsNoRowTwice() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        val newest = page(listOf(rows[0]), unreadCount = 2, hasMore = true, nextBefore = 1_700_000_000_000L)
        fake.stubSequence(
            "listMyNotifications",
            newest,
            // "Show older": the last page.
            page(listOf(rows[3]), unreadCount = 2),
            // The bell's listener saw a change: the newest page again, which
            // still says there is more after it.
            newest,
        )
        var revision by androidx.compose.runtime.mutableStateOf(0)
        setThemedContent {
            NotificationsListScreen(kinfolkId = "fam-1", portalApi = PortalApi(fake), liveRevision = revision, nowMs = { now })
        }
        waitForIdle()
        onNodeWithTag("notificationsOlder").performClick()
        waitForIdle()
        onNodeWithTag("notificationsOlder").assertDoesNotExist()
        revision = 1
        waitForIdle()
        assertEquals(3, fake.calls.count { it.first == "listMyNotifications" })
        onNodeWithTag("notificationRow-n-visit").assertExists()
        onNodeWithTag("notificationRow-n-tale").assertExists()
        // The older page is already on screen, so there is nothing more to offer.
        onNodeWithTag("notificationsOlder").assertDoesNotExist()
    }
    @Test
    fun aReloadOnTheFirstPageTakesTheFreshCursor_andShowOlderListsNoRowTwice() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        val arrived = row("n-omw", "Your Auntie is on the way", minutesAgo = 0)
        fake.stubSequence(
            "listMyNotifications",
            // A full first page: n-visit, n-batch, and more behind them.
            page(listOf(rows[0], rows[1]), hasMore = true, nextBefore = 1_700_000_000_200L),
            // A notice arrived: it pushes n-batch off the newest page, and the
            // cursor now sits at n-visit.
            page(listOf(arrived, rows[0]), hasMore = true, nextBefore = 1_700_000_000_300L),
            // "Show older" from that cursor starts at n-batch.
            page(listOf(rows[1], rows[3])),
        )
        var revision by androidx.compose.runtime.mutableStateOf(0)
        setThemedContent {
            NotificationsListScreen(kinfolkId = "fam-1", portalApi = PortalApi(fake), liveRevision = revision, nowMs = { now })
        }
        waitForIdle()
        revision = 1
        waitForIdle()
        onNodeWithTag("notificationRow-n-omw").assertExists()
        onNodeWithTag("notificationsOlder").performClick()
        waitForIdle()
        val asked = fake.calls.filter { it.first == "listMyNotifications" }
        assertEquals(3, asked.size)
        assertEquals(1_700_000_000_300L, asked[2].second?.get("before")?.jsonPrimitive?.content?.toLong())
        assertEquals(1, onAllNodesWithTag("notificationRow-n-batch").fetchSemanticsNodes().size)
        onNodeWithTag("notificationRow-n-visit").assertExists()
        onNodeWithTag("notificationRow-n-tale").assertExists()
    }
    @Test
    fun aFailedQuietReloadKeepsTheRowsOnScreen_andShowsNoError() = runComposeUiTest {
        val fake = stubbed()
        var revision by androidx.compose.runtime.mutableStateOf(0)
        setThemedContent {
            NotificationsListScreen(kinfolkId = "fam-1", portalApi = PortalApi(fake), liveRevision = revision, nowMs = { now })
        }
        waitForIdle()
        fake.stubError("listMyNotifications", IllegalStateException("notifications unavailable"))
        revision = 1
        waitForIdle()
        onNodeWithText("Visit confirmed").assertExists()
        onNodeWithTag("notificationsError").assertDoesNotExist()
    }
    @Test
    fun mergeNewestPage_putsFreshRowsFirst_keepsOlderPages_andDropsRowsNoLongerListed() {
        fun item(id: String, at: Long?) = com.kinfolk.portal.portal.NotificationItem(
            id = id, key = "k", category = "c", title = id, description = "", actorName = "", actorPhotoUrl = "",
            targetType = "", targetId = "", visitId = null, batchId = null, createdAtMs = at, readAtMs = null,
        )
        val shown = listOf(item("c", 300), item("b", 200), item("a", 100), item("old", 50))
        // "b" was archived since: the fresh page spans 400..100 and no longer holds it.
        val fresh = listOf(item("new", 400), item("c", 300), item("a", 100))
        assertEquals(listOf("new", "c", "a", "old"), mergeNewestPage(shown, fresh).map { it.id })
        assertEquals(emptyList(), mergeNewestPage(shown, emptyList()))
    }
}
