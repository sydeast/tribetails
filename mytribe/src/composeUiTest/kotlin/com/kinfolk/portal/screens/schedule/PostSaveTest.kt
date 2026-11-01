@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.schedule

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFirestoreClient
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.firebase.FunctionsClient
import com.kinfolk.portal.portal.Booking
import com.kinfolk.portal.portal.BookingStatus
import com.kinfolk.portal.portal.BookingsResult
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
import kotlin.test.assertNotNull
import kotlin.test.assertNull

private fun ComposeUiTest.clickFooter(label: String) {
    onNodeWithText(label).performScrollTo().performClick()
    waitForIdle()
}

/** Kin, one KinCare, the 10th of next month in the Evening block, then Review. */
private fun ComposeUiTest.fillToReview() {
    waitForIdle()
    clickFooter("Next")
    onNodeWithText("Auntie's In").performClick()
    clickFooter("Next")
    onNodeWithContentDescription("Next month").performClick()
    waitForIdle()
    onNodeWithText("10").performClick()
    waitForIdle()
    onNodeWithText("Evening (5 PM to 9 PM)").performScrollTo().performClick()
    waitForIdle()
    clickFooter("Next")
    clickFooter("Next")
}

/**
 * #1281 on the portal Android app. The web mirror is "BookingWizard: #1281
 * after a successful Create Booking" in mytribe/web/src/screens/BookingWizard.test.tsx.
 *
 * The wizard cleared its idempotency key on success and re-enabled Create
 * Booking in `finally`, so a tap landing before the screen closed minted a new
 * key and booked twice. Schedule then opened on a load. Now the key is held,
 * the button stays shut once the booking is in, and the fresh list rides along
 * to Schedule with the confirmation in words.
 */
class PostSaveTest {

    private fun stubWizard(fake: FakeFunctionsClient) {
        fake.stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray { add(buildJsonObject { put("id", "k1"); put("name", "Buddy"); put("status", "active") }) })
        })
        fake.stub("getServiceCatalog", buildJsonObject {
            put("services", buildJsonArray {
                add(buildJsonObject {
                    put("id", "s1"); put("name", "Auntie's In"); put("category", "Held Down at Home"); put("priceCents", 2500L)
                })
            })
        })
        fake.stub("getBookingPolicy", buildJsonObject {
            put("allowTimeBlockBooking", true)
            put("allowSpecificTimeBooking", false)
            put("defaultBookingMode", "TIME_BLOCK")
            put("timeBlocks", buildJsonArray {
                add(buildJsonObject {
                    put("id", "evening"); put("label", "Evening")
                    put("startTime", "17:00"); put("endTime", "21:00"); put("durationMinutes", 240)
                })
            })
        })
    }

    private fun listWith(id: String, title: String) = buildJsonObject {
        put("liveVisit", JsonNull)
        put("upcoming", buildJsonArray {
            add(buildJsonObject { put("id", id); put("status", "requested"); put("title", title); put("batchId", "batch-1") })
        })
        put("recent", buildJsonArray {})
    }

    @Test
    fun createBooking_handsTheFreshListOn_andTheButtonStaysShut() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubWizard(fake)
        fake.stub("requestBooking", buildJsonObject { put("batchId", "batch-1") })
        fake.stub("getMyBookings", listWith("v-new", "Evening walk"))
        val completions = mutableListOf<BookingsResult?>()
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = { completions += it })
        }
        fillToReview()
        clickFooter("Create Booking")

        assertEquals(1, completions.size)
        assertEquals(listOf("v-new"), completions.single()?.upcoming?.map { it.id })
        // The list was read AFTER the booking went in, not before.
        val names = fake.calls.map { it.first }
        assertEquals(true, names.lastIndexOf("getMyBookings") > names.indexOf("requestBooking"))

        // The host did not close the screen here, so the button is still on it.
        onNodeWithText("Booking requested").assertIsNotEnabled()
        onNodeWithText("Booking requested").performScrollTo().performClick()
        waitForIdle()
        assertEquals(1, fake.calls.count { it.first == "requestBooking" })
    }

    @Test
    fun aFailedSubmit_keepsItsKey_soTheRetryNamesTheSameBooking() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubWizard(fake)
        fake.stubError("requestBooking", IllegalStateException("Could not reach your Auntie."))
        fake.stub("getMyBookings", listWith("v-new", "Evening walk"))
        val completions = mutableListOf<BookingsResult?>()
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = { completions += it })
        }
        fillToReview()
        clickFooter("Create Booking")
        onNodeWithText("Could not reach your Auntie.").assertExists()

        fake.stub("requestBooking", buildJsonObject { put("batchId", "batch-1") })
        clickFooter("Create Booking")

        val keys = fake.calls.filter { it.first == "requestBooking" }.map { it.second!!["idempotencyKey"]!!.jsonPrimitive.content }
        assertEquals(2, keys.size)
        assertEquals(keys[0], keys[1])
        assertEquals(1, completions.size)
    }

    /** #1382: the server's weekly-hours refusal reaches the household as sent, and Create stays usable. */
    @Test
    fun aWeeklyHoursRefusal_isShownAsSent_andTheHouseholdCanTryAgain() = runComposeUiTest {
        val refusal = "2026-11-04: That time is outside our hours on Wednesdays (09:00 to 17:00). Pick a time inside them."
        val fake = FakeFunctionsClient()
        stubWizard(fake)
        fake.stubError("requestBooking", IllegalStateException(refusal))
        val completions = mutableListOf<BookingsResult?>()
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = { completions += it })
        }
        fillToReview()
        clickFooter("Create Booking")
        onNodeWithText(refusal).assertExists()
        assertEquals(0, completions.size)
        onNodeWithText("Create Booking").assertIsEnabled()
    }
    @Test
    fun schedule_opensOnTheHandoff_withTheConfirmation_whileItsOwnReadIsStillOut() = runComposeUiTest {
        // Every read hangs, so only the handoff can explain what is on screen.
        val hanging = object : FunctionsClient {
            override suspend fun call(name: String, payload: JsonObject?): JsonObject = awaitCancellation()
        }
        val visit = Booking(
            id = "v-new", kinfolkId = "3", status = BookingStatus.Requested, serviceType = null, title = "Evening walk",
            startTimeMs = null, endTimeMs = null, kinIds = emptyList(), kinNames = emptyList(), auntieDisplayName = null,
            auntieAvatarUrl = null, notes = null, createdAtMs = null, visitProgress = null, batchId = "batch-1",
        )
        var handoff: ScheduleHandoff? = ScheduleHandoff(
            bookings = BookingsResult(liveVisit = null, upcoming = listOf(visit), recent = emptyList()),
            notice = "Booking requested",
        )
        setThemedContent {
            ScheduleScreen(
                "The Foster", "3", PortalApi(hanging), FakeFirestoreClient(),
                handoff = handoff,
                onHandoffTaken = { handoff = null },
            )
        }
        waitForIdle()

        onNodeWithText("Evening walk").assertIsDisplayed()
        onNodeWithTag(SAVE_NOTICE_TAG).assertIsDisplayed()
        onNodeWithText("Booking requested").assertIsDisplayed()
        onNodeWithText("No upcoming bookings").assertDoesNotExist()
        onNodeWithText("Loading your schedule…").assertDoesNotExist()
        assertNull(handoff)
    }

    @Test
    fun schedule_withNoHandoff_isUnchanged() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", listWith("v1", "Park Adventure"))
        setThemedContent { ScheduleScreen("The Foster", "3", PortalApi(fake), FakeFirestoreClient()) }
        waitForIdle()
        onNodeWithText("Park Adventure").assertIsDisplayed()
        onNodeWithTag(SAVE_NOTICE_TAG).assertDoesNotExist()
        assertNotNull(fake.calls.firstOrNull { it.first == "getMyBookings" })
    }
}
class HomeHandoffTest {
    @Test
    fun home_opensOnTheHandoff_withTheConfirmation_whileItsOwnReadIsStillOut() = runComposeUiTest {
        val hanging = object : FunctionsClient {
            override suspend fun call(name: String, payload: JsonObject?): JsonObject = awaitCancellation()
        }
        val visit = Booking(
            id = "v-new", kinfolkId = "3", status = BookingStatus.Requested, serviceType = null, title = "Evening walk",
            startTimeMs = null, endTimeMs = null, kinIds = emptyList(), kinNames = emptyList(), auntieDisplayName = null,
            auntieAvatarUrl = null, notes = null, createdAtMs = null, visitProgress = null, batchId = "batch-1",
        )
        var handoff: ScheduleHandoff? = ScheduleHandoff(
            bookings = BookingsResult(liveVisit = null, upcoming = listOf(visit), recent = emptyList()),
            notice = "Booking requested",
        )
        setThemedContent {
            com.kinfolk.portal.screens.home.HomeScreen(
                "The Foster", "3", PortalApi(hanging),
                handoff = handoff,
                onHandoffTaken = { handoff = null },
            )
        }
        waitForIdle()
        onNodeWithTag(SAVE_NOTICE_TAG).assertIsDisplayed()
        onNodeWithText("Booking requested").assertIsDisplayed()
        onNodeWithText("Evening walk").assertExists()
        assertNull(handoff)
    }
    @Test
    fun home_withNoHandoff_showsNoConfirmation() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        setThemedContent { com.kinfolk.portal.screens.home.HomeScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithTag(SAVE_NOTICE_TAG).assertDoesNotExist()
    }
}
