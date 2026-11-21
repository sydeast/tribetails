package com.tribetails.auntieos.web.screens.booking

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.NotificationEntry
import com.tribetails.auntieos.web.screens.notifications.NotificationsScreen
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #2121: a Kinfolk's request to remove a Kin can be opened and answered on the
 * console. The notice's Open lands on Bookings with that request marked, and
 * Archive and Decline work through the callables admin web calls.
 */
@OptIn(ExperimentalTestApi::class)
class KinRemovalQueueRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val biscuit = """{"id":"kf1_k1","kinfolkId":"kf1","kinId":"k1","flatKinId":"flat1","kinName":"Biscuit",
        "reason":"Rehomed with family","status":"pending","requestedAtMs":1793642400000,"resolvedAtMs":null,"resolutionNote":null}"""
    private val pepper = """{"id":"kf2_k7","kinfolkId":"kf2","kinId":"k7","flatKinId":"flat7","kinName":"Pepper",
        "reason":null,"status":"pending","requestedAtMs":1793642400000,"resolvedAtMs":null,"resolutionNote":null}"""

    private fun seed() {
        JvmFirestoreFixtures.businessSettings = BusinessSettings(timeZone = "America/Chicago")
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1", firstName = "Ada", lastName = "Wren"))
        JvmFirestoreFixtures.incomingKinCares = emptyList()
        JvmFirestoreFixtures.bookingRequests = emptyList()
        JvmFirestoreFixtures.sessions = emptyList()
    }

    private fun ComposeUiTest.showBookings(focus: String? = null, onConsumed: () -> Unit = {}) {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                BookingScreen(focusKinRemovalId = focus, onKinRemovalFocusConsumed = onConsumed)
            }
        }
    }

    private fun ComposeUiTest.shows(text: String) =
        onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun ComposeUiTest.tagged(tag: String) =
        onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun sent(name: String) = JvmFirestoreFixtures.callablePayloads.filter { it.first == name }

    @Test
    fun theNoticesRequestIsListedAndMarked() = runDesktopComposeUiTest {
        seed()
        JvmFirestoreFixtures.callableResponses = mapOf("listKinRemovalRequests" to """{"requests":[$biscuit,$pepper]}""")
        var consumed = 0
        showBookings(focus = "kf1_k1") { consumed++ }
        waitUntil(timeoutMillis = 10_000) { tagged(KIN_REMOVAL_ROW_TAG) == 2 }
        assertEquals(1, tagged(KIN_REMOVAL_FOCUS_TAG), "only the notice's request is marked")
        assertTrue(shows("Kin removal requests"))
        assertTrue(shows("2 waiting"))
        assertTrue(shows("The household asked on Nov 2, 2026 to remove Biscuit from their profile."))
        assertTrue(shows("Rehomed with family"))
        assertTrue(shows("Ada Wren"), "the household is named from the directory")
        assertEquals(1, consumed)
        assertTrue(!shows(KIN_REMOVAL_ANSWERED_BODY))
    }

    @Test
    fun archiveConfirmsFirstThenTheRequestLeavesTheList() = runDesktopComposeUiTest {
        seed()
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listKinRemovalRequests" to """{"requests":[$biscuit]}""",
            "resolveKinRemovalRequest" to """{"ok":true,"decision":"archive","request":${biscuit.replace("\"pending\"", "\"archived\"")},
                "flatArchived":true,"familyArchived":true,"householdNotified":true}""",
        )
        showBookings()
        waitUntil(timeoutMillis = 10_000) { tagged(KIN_REMOVAL_ROW_TAG) == 1 }

        onNodeWithText("Archive", useUnmergedTree = true).performClick()
        waitForIdle()
        assertTrue(shows("Archive Biscuit"))
        assertTrue(sent("resolveKinRemovalRequest").isEmpty(), "nothing is sent until the confirm")
        onNodeWithText("Archive it", useUnmergedTree = true).performClick()

        waitUntil(timeoutMillis = 10_000) { tagged(KIN_REMOVAL_ROW_TAG) == 0 }
        assertTrue(shows("Biscuit is archived. The household has your answer."))
        val body = Json.parseToJsonElement(sent("resolveKinRemovalRequest").single().second).jsonObject
        assertEquals("kf1_k1", body["requestId"]!!.jsonPrimitive.content)
        assertEquals("archive", body["decision"]!!.jsonPrimitive.content)
    }

    @Test
    fun aRefusedDeclineShowsTheServersSentenceAndKeepsTheRequest() = runDesktopComposeUiTest {
        seed()
        JvmFirestoreFixtures.callableResponses = mapOf("listKinRemovalRequests" to """{"requests":[$biscuit]}""")
        JvmFirestoreFixtures.callableErrors = mapOf("resolveKinRemovalRequest" to "This removal request has already been answered.")
        showBookings()
        waitUntil(timeoutMillis = 10_000) { tagged(KIN_REMOVAL_ROW_TAG) == 1 }

        onNodeWithText("Decline", useUnmergedTree = true).performClick()
        waitForIdle()
        assertTrue(shows("Keep Biscuit"))
        onNodeWithText("Send the decline", useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { shows("This removal request has already been answered.") }
        assertTrue(shows("Not done"))
        assertEquals(1, tagged(KIN_REMOVAL_ROW_TAG))
    }

    @Test
    fun aRequestAnsweredBeforeArrivalSaysSo() = runDesktopComposeUiTest {
        seed()
        JvmFirestoreFixtures.callableResponses = mapOf("listKinRemovalRequests" to """{"requests":[]}""")
        showBookings(focus = "kf1_k1")
        waitUntil(timeoutMillis = 10_000) { shows(KIN_REMOVAL_ANSWERED_BODY) }
        assertTrue(shows(KIN_REMOVAL_ANSWERED_TITLE))
        assertEquals(0, tagged(KIN_REMOVAL_ROW_TAG))
    }

    @Test
    fun aFailedReadSaysSoWithRetry() = runDesktopComposeUiTest {
        seed()
        JvmFirestoreFixtures.callableErrors = mapOf("listKinRemovalRequests" to "The server could not be reached. Try again in a moment.")
        showBookings()
        waitUntil(timeoutMillis = 10_000) { shows("Couldn't load Kin removal requests") }
        assertTrue(shows("The server could not be reached. Try again in a moment."))
        val before = sent("listKinRemovalRequests").size
        JvmFirestoreFixtures.callableErrors = emptyMap()
        JvmFirestoreFixtures.callableResponses = mapOf("listKinRemovalRequests" to """{"requests":[$biscuit]}""")
        onNodeWithText("Retry", useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { tagged(KIN_REMOVAL_ROW_TAG) == 1 }
        assertTrue(sent("listKinRemovalRequests").size > before)
    }

    @Test
    fun openOnTheNoticeHandsBackTheRequestNotTheHousehold() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.notifications = listOf(
            NotificationEntry(
                _id = "n1",
                key = "kin.removal.requested",
                title = "Kinfolk asked to remove a Kin",
                targetType = "kinfolk",
                targetId = "kf1",
                createdAt = "2026-11-12T16:50:00Z",
                data = buildJsonObject {
                    put("kinfolkId", JsonPrimitive("kf1"))
                    put("requestId", JsonPrimitive("kf1_k1"))
                },
            ),
        )
        JvmFirestoreFixtures.businessSettings = BusinessSettings(timeZone = "America/Chicago")
        JvmFirestoreFixtures.incomingKinCares = emptyList()
        var opened: String? = null
        var target: Pair<String, String>? = null
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                NotificationsScreen(
                    client = FirestoreClient(),
                    onOpenKinRemoval = { opened = it },
                    onOpenTarget = { t, i -> target = t to i },
                )
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithContentDescription("Open linked item", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithContentDescription("Open linked item", useUnmergedTree = true).performClick()
        waitForIdle()
        assertEquals("kf1_k1", opened)
        assertEquals(null, target)
    }
}
