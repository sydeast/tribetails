@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.schedule

import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFirestoreClient
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.firebase.FunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1919 and #2029 on the portal Android app. The web mirrors are "BookingDetail:
 * a send that got no answer (#1919)" and "BookingDetail: a declined request
 * (#2029)" in mytribe/web/src/screens/BookingDetail.test.tsx.
 */
class NoAnswerAndDeclinedTest {

    /** 2026-08-17T15:30:00Z, a Monday (same clock as RescheduleRequestSectionTest). */
    private val fixedNow = 1_786_980_600_000L
    private val tenHoursMs = 10L * 60L * 60L * 1000L

    private fun list(extra: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject {
        put("liveVisit", JsonNull)
        put("upcoming", buildJsonArray {
            add(buildJsonObject {
                put("id", "v1"); put("kinfolkId", "fam-1"); put("status", "confirmed")
                put("title", "Park Adventure"); put("serviceType", "Drop-in Visit")
                put("startTimeMs", fixedNow + tenHoursMs); put("batchId", "batch-1")
                extra()
            })
        })
        put("recent", buildJsonArray {})
    }

    /**
     * The server saved the ask and the reply was lost: the write throws the way
     * Android's SDK does at its deadline, and the list read after it shows the
     * ask on file when [lands] says the server kept it.
     */
    private class LostReply(
        val fake: FakeFunctionsClient,
        private val write: String,
        private val afterWrite: (JsonObject?) -> JsonObject?,
    ) : FunctionsClient {
        override suspend fun call(name: String, payload: JsonObject?): JsonObject {
            if (name == write) {
                fake.calls += name to payload
                afterWrite(payload)?.let { fake.stub("getMyBookings", it) }
                throw IllegalStateException("DEADLINE_EXCEEDED")
            }
            return fake.call(name, payload)
        }
    }

    private fun androidx.compose.ui.test.ComposeUiTest.sendReschedule() {
        onNodeWithText("Reschedule visit").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("20").performScrollTo().performClick()
        onNodeWithTag("rescheduleTime").performTextInput("13:00")
        waitForIdle()
        onNodeWithText("Send this time to your Auntie").performScrollTo().performClick()
        waitForIdle()
    }

    @Test
    fun reschedule_noAnswer_butTheTimeIsOnFile_endsAsSent() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", list())
        val client = LostReply(fake, "requestBookingReschedule") { payload ->
            val sent = payload!!["proposedStartTimeMs"]!!.jsonPrimitive.long
            list { put("rescheduleRequestStatus", "pending"); put("rescheduleRequestedStartTimeMs", sent) }
        }
        setThemedContent {
            KinCareDetailScreen(kinCareId = "v1", kinfolkId = "fam-1", portalApi = PortalApi(client), onBack = {}, nowMs = { fixedNow })
        }
        waitForIdle()
        sendReschedule()

        onNodeWithText("New time requested", substring = true).assertExists()
        onNodeWithText("Send this time to your Auntie").assertDoesNotExist()
        onNodeWithText("No answer came back", substring = true).assertDoesNotExist()
        assertEquals(1, fake.calls.count { it.first == "requestBookingReschedule" })
    }

    @Test
    fun reschedule_noAnswer_andNothingOnFile_saysSoInPlainWords() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", list())
        val client = LostReply(fake, "requestBookingReschedule") { null }
        setThemedContent {
            KinCareDetailScreen(kinCareId = "v1", kinfolkId = "fam-1", portalApi = PortalApi(client), onBack = {}, nowMs = { fixedNow })
        }
        waitForIdle()
        sendReschedule()

        onNodeWithText(
            "No answer came back within 70 seconds, so it may still have gone through. Check before trying again.",
        ).assertExists()
        onNodeWithText("DEADLINE_EXCEEDED", substring = true).assertDoesNotExist()
        onNodeWithText("Send this time to your Auntie").assertExists()
        // It looked before it spoke: the first read, then the check.
        assertEquals(2, fake.calls.count { it.first == "getMyBookings" })
    }

    @Test
    fun cancel_noAnswer_butTheAskIsOnFile_endsAsSent() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", list())
        val client = LostReply(fake, "requestBookingCancellation") {
            list { put("cancelRequested", true); put("cancelRequestStatus", "pending") }
        }
        setThemedContent {
            KinCareDetailScreen(kinCareId = "v1", kinfolkId = "fam-1", portalApi = PortalApi(client), onBack = {}, nowMs = { fixedNow })
        }
        waitForIdle()
        onNodeWithText("Request cancellation").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Send request").performScrollTo().performClick()
        waitForIdle()

        onNodeWithText("Cancellation requested", substring = true).performScrollTo().assertExists()
        onNodeWithText("No answer came back", substring = true).assertDoesNotExist()
    }

    @Test
    fun declinedRequest_readsDeclined_andPromisesNoAuntie() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", list { put("status", "cancelled"); put("requestDeclinedAtMs", fixedNow - 60_000L) })
        fake.stub("getBookingNotes", buildJsonObject { put("notes", buildJsonArray {}); put("fromBusiness", buildJsonArray {}) })
        setThemedContent {
            KinCareDetailScreen(kinCareId = "v1", kinfolkId = "fam-1", portalApi = PortalApi(fake), onBack = {}, nowMs = { fixedNow })
        }
        waitForIdle()
        onNodeWithText("Declined").assertExists()
        onNodeWithText("Cancelled").assertDoesNotExist()
        onNodeWithText("Not assigned").assertExists()
        onNodeWithText("Pending").assertDoesNotExist()
    }

    @Test
    fun declinedRequest_readsDECLINED_onTheScheduleList() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", list { put("status", "cancelled"); put("requestDeclinedAtMs", fixedNow - 60_000L) })
        setThemedContent { ScheduleScreen("The Foster", "fam-1", PortalApi(fake), FakeFirestoreClient()) }
        waitForIdle()
        onNodeWithText("DECLINED").assertExists()
        onNodeWithText("CANCELLED").assertDoesNotExist()
    }

    @Test
    fun cancelledVisit_stillReadsCANCELLED_onTheScheduleList() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", list { put("status", "cancelled") })
        setThemedContent { ScheduleScreen("The Foster", "fam-1", PortalApi(fake), FakeFirestoreClient()) }
        waitForIdle()
        onNodeWithText("CANCELLED").assertExists()
        onNodeWithText("DECLINED").assertDoesNotExist()
    }
}
