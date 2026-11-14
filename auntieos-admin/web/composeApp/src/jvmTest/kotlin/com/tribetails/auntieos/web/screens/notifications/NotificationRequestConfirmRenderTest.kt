package com.tribetails.auntieos.web.screens.notifications

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareVisit
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.NotificationEntry
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1875: one press of Deny on a waiting request's row declined it and told the
 * household, with no confirm. The press now opens the confirm step (household,
 * day, who will be told, note box) and nothing is sent until it is confirmed.
 * #2069: an old unstamped row the queue does not hold offers no decision.
 * #2028: Open on a request row hands back the household and request id.
 */
@OptIn(ExperimentalTestApi::class)
class NotificationRequestConfirmRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun request(id: String, batchId: String) = NotificationEntry(
        _id = id,
        key = "kincare.requested",
        title = "Kinfolk requested a KinCare visit",
        targetType = "booking",
        targetId = batchId,
        createdAt = "2026-11-12T16:50:00Z",
        data = buildJsonObject { put("kinfolkId", JsonPrimitive("kf1")) },
    )

    private fun seed(vararg rows: NotificationEntry) {
        JvmFirestoreFixtures.notifications = rows.toList()
        JvmFirestoreFixtures.businessSettings = BusinessSettings(timeZone = "America/Chicago")
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1", firstName = "Ada", lastName = "Wren"))
        JvmFirestoreFixtures.incomingKinCares = listOf(
            KinCareVisit(
                _id = "v1",
                path = "families/kf1/bookings/req_new/kinCares/v1",
                kinfolkName = "The Wrens",
                startTime = "2026-11-19T17:00:00Z",
                status = "requested",
            ),
        )
    }

    @Test
    fun denyOpensAConfirmAndSendsNothingUntilConfirmed() = runDesktopComposeUiTest {
        seed(request("n1", "req_new"))
        JvmFirestoreFixtures.callableResponses =
            mapOf("manageBookingSeries" to """{"ok":true,"action":"CANCEL","batchId":"req_new","affectedVisits":1,"failedVisits":0}""")
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { NotificationsScreen(client = FirestoreClient()) } }

        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithContentDescription("Deny booking", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithContentDescription("Deny booking", useUnmergedTree = true).performClick()
        waitForIdle()

        onNodeWithText("Turn down this request from The Wrens", useUnmergedTree = true).assertExists()
        onNodeWithText("Thu, Nov 19 at 11:00 AM will not be booked. The household will be told.", useUnmergedTree = true).assertExists()
        onNodeWithText("Anything to add for the household (optional)", ignoreCase = true, useUnmergedTree = true).assertExists()
        assertTrue(JvmFirestoreFixtures.callablePayloads.none { it.first == "manageBookingSeries" }, "nothing is sent on the row press")

        onNodeWithText("Turn it down", useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Request declined.", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(1, JvmFirestoreFixtures.callablePayloads.count { it.first == "manageBookingSeries" })
    }

    @Test
    fun neverMindSendsNothing() = runDesktopComposeUiTest {
        seed(request("n1", "req_new"))
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { NotificationsScreen(client = FirestoreClient()) } }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithContentDescription("Approve booking", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithContentDescription("Approve booking", useUnmergedTree = true).performClick()
        waitForIdle()
        onNodeWithText("Book this request for The Wrens", useUnmergedTree = true).assertExists()
        onNodeWithText("Never mind", useUnmergedTree = true).performClick()
        waitForIdle()
        onNodeWithText("Book this request for The Wrens", useUnmergedTree = true).assertDoesNotExist()
        assertTrue(JvmFirestoreFixtures.callablePayloads.none { it.first == "manageBookingSeries" })
    }

    @Test
    fun anOldRowTheQueueDoesNotHoldOffersNoDecision() = runDesktopComposeUiTest {
        seed(request("n2", "req_august"))
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { NotificationsScreen(client = FirestoreClient()) } }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Answered", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(onAllNodesWithContentDescription("Approve booking", useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
        assertTrue(onAllNodesWithContentDescription("Deny booking", useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
        onNodeWithContentDescription("Open linked item", useUnmergedTree = true).assertExists()
    }

    @Test
    fun openOnARequestRowHandsBackTheHouseholdAndRequest() = runDesktopComposeUiTest {
        seed(request("n1", "req_new"))
        var opened: Pair<String, String>? = null
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                NotificationsScreen(client = FirestoreClient(), onOpenVisitRequest = { k, b -> opened = k to b })
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithContentDescription("Open linked item", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithContentDescription("Open linked item", useUnmergedTree = true).performClick()
        waitForIdle()
        assertEquals("kf1" to "req_new", opened)
    }
}
