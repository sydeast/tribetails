package com.tribetails.auntieos.web.screens.booking

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #2243: Bookings on the console lists a household's ask to move or cancel a
 * booked visit, with the same Accept and Decline steps as admin web: a confirm
 * with a note box, "Working…" while the answer is out, the server's sentence on
 * a refusal, and the answer named for its household once it lands.
 */
@OptIn(ExperimentalTestApi::class)
class VisitAskQueueRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    // 2026-11-25T20:00:00Z (14:00 Chicago) to 2026-11-26T15:30:00Z (09:30 Chicago).
    private val moveRow = """{"kinfolkId":"kf1","batchId":"b1","visitId":"v1","kinfolkName":"The Wrens",
        "title":null,"serviceType":"Drop-in","kinNames":["Biscuit"],"status":"scheduled",
        "currentStartTimeMs":1795636800000,"currentEndTimeMs":null,"proposedStartTimeMs":1795707000000,
        "proposedEndTimeMs":null,"reason":"Flight moved","requestedAtMs":1795000000000}"""
    private val cancelRow = """{"kinfolkId":"kf2","batchId":"b2","visitId":"v2","kinfolkName":"The Fenns",
        "title":null,"serviceType":"Drop-in","kinNames":[],"status":"scheduled","startTimeMs":1795636800000,
        "endTimeMs":null,"reason":null,"requestedAtMs":1795100000000}"""

    private fun seed() {
        JvmFirestoreFixtures.businessSettings = BusinessSettings(timeZone = "America/Chicago")
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1", firstName = "Ada", lastName = "Wren"))
        // No new booking request is waiting: the move and the cancellation must still show.
        JvmFirestoreFixtures.incomingKinCares = emptyList()
        JvmFirestoreFixtures.bookingRequests = emptyList()
        JvmFirestoreFixtures.sessions = emptyList()
    }

    private fun ComposeUiTest.show() {
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { BookingScreen() } }
    }

    private fun ComposeUiTest.shows(text: String) =
        onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun ComposeUiTest.rows() =
        onAllNodesWithTag(VISIT_ASK_ROW_TAG, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun sent(name: String) = JvmFirestoreFixtures.callablePayloads.filter { it.first == name }

    @Test
    fun aMoveAndACancellationShowWithNoNewRequestWaiting() = runDesktopComposeUiTest {
        seed()
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listRescheduleRequests" to """{"requests":[$moveRow]}""",
            "listCancelRequests" to """{"requests":[$cancelRow]}""",
        )
        show()
        waitUntil(timeoutMillis = 10_000) { rows() == 2 }
        assertTrue(shows("The Wrens"))
        assertTrue(shows("The Fenns"))
        assertTrue(shows("Nov 25, 2026 14:00 → Nov 26, 2026 09:30"))
        assertTrue(shows("Flight moved"))
        assertTrue(shows("RESCHEDULE"))
        assertTrue(shows("CANCEL"))
    }

    @Test
    fun acceptingAMoveConfirmsFirstAndARefusalShowsTheServersSentence() = runDesktopComposeUiTest {
        seed()
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listRescheduleRequests" to """{"requests":[$moveRow]}""",
            "listCancelRequests" to """{"requests":[]}""",
        )
        JvmFirestoreFixtures.callableErrors = mapOf("resolveBookingRescheduleRequest" to "Auntie has a busy block at that time.")
        JvmFirestoreFixtures.callableErrorCodes = mapOf("resolveBookingRescheduleRequest" to "booking_busy_conflict")
        show()
        waitUntil(timeoutMillis = 10_000) { rows() == 1 }

        onNodeWithText("Accept", useUnmergedTree = true).performClick()
        waitForIdle()
        assertTrue(shows("Move this visit for The Wrens"))
        assertTrue(shows("This visit will move from Nov 25, 2026 14:00 to Nov 26, 2026 09:30."))
        assertTrue(shows("NOTE FOR THE HOUSEHOLD (OPTIONAL)") || shows("Note for the household (optional)"))
        assertTrue(sent("resolveBookingRescheduleRequest").isEmpty(), "nothing is sent until the confirm")

        onNodeWithText("Move it", useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { shows("Auntie has a busy block at that time.") }
        assertTrue(shows("Not done"))
        assertEquals(1, sent("resolveBookingRescheduleRequest").size)

        // The knowing retry carries the override the server named.
        onNodeWithText("Accept anyway", useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { sent("resolveBookingRescheduleRequest").size == 2 }
        val retry = Json.parseToJsonElement(sent("resolveBookingRescheduleRequest").last().second).jsonObject
        assertEquals("true", retry["overrideBusyConflict"]!!.jsonPrimitive.content)
        waitForIdle()
        assertTrue(!shows("Accept anyway"), "the same override is not offered twice")
        assertEquals(1, rows(), "a refused ask stays on the list")
    }

    @Test
    fun aDeclinedCancellationLeavesTheListAndNamesTheHousehold() = runDesktopComposeUiTest {
        seed()
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listRescheduleRequests" to """{"requests":[]}""",
            "listCancelRequests" to """{"requests":[$cancelRow]}""",
            "resolveBookingCancellationRequest" to
                """{"ok":true,"visitId":"v2","decision":"decline","status":"scheduled","sessionUpdated":false,"rescheduleRequestClosed":false}""",
        )
        show()
        waitUntil(timeoutMillis = 10_000) { rows() == 1 }

        onNodeWithText("Decline", useUnmergedTree = true).performClick()
        waitForIdle()
        assertTrue(shows("Keep this visit for The Fenns"))
        assertTrue(shows("Nov 25, 2026 14:00 stays on the schedule. The household will be told it is going ahead."))
        onNodeWithText("Send the decline", useUnmergedTree = true).performClick()

        waitUntil(timeoutMillis = 10_000) { rows() == 0 }
        assertTrue(shows("The Fenns: Declined. The visit stays on the schedule and the household gets your answer."))
        val body = Json.parseToJsonElement(sent("resolveBookingCancellationRequest").single().second).jsonObject
        assertEquals("decline", body["decision"]!!.jsonPrimitive.content)
    }

    @Test
    fun aFailedQueueSaysSoBesideTheOneThatLoaded() = runDesktopComposeUiTest {
        seed()
        JvmFirestoreFixtures.callableResponses = mapOf("listCancelRequests" to """{"requests":[$cancelRow]}""")
        JvmFirestoreFixtures.callableErrors = mapOf("listRescheduleRequests" to "The server could not be reached. Try again in a moment.")
        show()
        waitUntil(timeoutMillis = 10_000) { shows("One of these queues didn't load") }
        assertTrue(shows("Reschedule requests: The server could not be reached. Try again in a moment. Anything waiting there is not on this list."))
        assertEquals(1, rows(), "the cancellation queue still shows its row")
    }

    @Test
    fun theDetailSheetOpensFromTheCard() = runDesktopComposeUiTest {
        seed()
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listRescheduleRequests" to """{"requests":[$moveRow]}""",
            "listCancelRequests" to """{"requests":[]}""",
        )
        show()
        waitUntil(timeoutMillis = 10_000) { rows() == 1 }
        onNodeWithText("Flight moved", useUnmergedTree = true).performClick()
        waitForIdle()
        assertTrue(shows("Reschedule from The Wrens"))
        assertTrue(shows("ASKED TO MOVE TO"))
        assertTrue(shows("Nov 26, 2026 09:30"))
    }
}
