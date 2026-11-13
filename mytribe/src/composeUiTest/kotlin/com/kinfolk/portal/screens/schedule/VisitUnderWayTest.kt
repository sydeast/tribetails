@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.schedule

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFirestoreClient
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1830 / #1832 / #1823 on the MyTribe app: a visit that is under way is on
 * Schedule with its current status, the live card names the Kin, opens the
 * visit and clears when the Auntie leaves, and the visit's own screen opens at
 * every status and follows the visit. The web mirrors are
 * `Schedule.underWay.test.tsx` and `BookingDetail.underWay.test.tsx`.
 *
 * #2123 (operator ruling 2026-11-12): a visit is Completed at departure. The
 * server sends it completed; an older answer's `active` + `ended` pair reads
 * Completed. No screen says Departed.
 */
class VisitUnderWayTest {
    // #2122: the screens re-read at a short turn here. A Compose UI test draws
    // every 16 ms frame of the time it moves through, so following a visit at
    // the app's real 30 seconds a turn drew about 13,000 frames: 12 seconds on
    // a developer Mac, and past runTest's one minute limit on a busy CI
    // runner. At 2 seconds a turn the same test takes about 1 second. The
    // real interval is held by FollowBookingsTest, which draws nothing.
    private companion object { const val TEST_POLL_MS = 2_000L }

    // The real clock: Schedule decides what is due against it.
    private val now = kotlin.time.Clock.System.now().toEpochMilliseconds()

    private fun visit(status: String, progress: String?, id: String = "v1"): JsonObject = buildJsonObject {
        put("id", id)
        put("kinfolkId", "3")
        put("batchId", "batch-1")
        put("status", status)
        if (progress == null) put("visitProgress", JsonNull) else put("visitProgress", progress)
        put("serviceType", "visit_30")
        put("serviceLabel", "30 Minute Quick Check")
        put("startTimeMs", now - 4 * 60_000L)
        put("sessionId", "vis_$id")
        put("auntieDisplayName", "Maya")
        put("kinNames", buildJsonArray { add("Biscuit"); add("Miso") })
    }

    /** The answer the server gives for one visit at this point of its life. */
    private fun answer(v: JsonObject, live: Boolean, listed: Boolean = true): JsonObject {
        val finished = v["status"].toString().trim('"') in setOf("completed", "cancelled")
        return buildJsonObject {
            put("liveVisit", if (live) v else JsonNull)
            put("upcoming", buildJsonArray { if (listed && !finished) add(v) })
            put("recent", buildJsonArray { if (listed && finished) add(v) })
            put("envelopes", buildJsonArray {
                add(buildJsonObject {
                    put("batchId", "batch-1")
                    put("kinCares", buildJsonArray { add(v) })
                })
            })
        }
    }

    private fun fakeWith(vararg answers: JsonObject): FakeFunctionsClient {
        val fake = FakeFunctionsClient()
        if (answers.size == 1) fake.stub("getMyBookings", answers[0]) else fake.stubSequence("getMyBookings", *answers)
        fake.stub("getMyVisits", buildJsonObject { put("visits", buildJsonArray {}) })
        fake.stub("getBookingNotes", buildJsonObject { put("bookingNote", JsonNull); put("notes", buildJsonArray {}) })
        return fake
    }

    private fun bookingsReads(fake: FakeFunctionsClient): Int = fake.calls.count { it.first == "getMyBookings" }

    // ---- Schedule ----

    private fun ComposeUiTest.showSchedule(fake: FakeFunctionsClient, opened: MutableList<String> = mutableListOf()) {
        setThemedContent {
            ScheduleScreen(
                "The Foster", "3", PortalApi(fake), FakeFirestoreClient(),
                onOpenKinCare = { visitId, _ -> opened += visitId },
                pollMs = TEST_POLL_MS,
            )
        }
        waitForIdle()
    }

    private fun onCard(text: String) = hasTestTag(LIVE_VISIT_TAG) and hasText(text, substring = true)

    @Test
    fun schedule_onTheWay_cardSaysSoNamesTheKinAndOpensTheVisit() = runComposeUiTest {
        val opened = mutableListOf<String>()
        showSchedule(fakeWith(answer(visit("enRoute", "enRoute"), live = true)), opened)

        onNode(onCard("ON THE WAY")).assertIsDisplayed()
        onNode(onCard("Auntie Maya is on the way")).assertIsDisplayed()
        onNode(onCard("To Biscuit, Miso")).assertIsDisplayed()
        onNode(onCard("at your place")).assertDoesNotExist()
        // On Upcoming as well, with its status.
        onNodeWithText("EN ROUTE").assertIsDisplayed()
        onNodeWithText("No upcoming bookings").assertDoesNotExist()

        onNodeWithTag(LIVE_VISIT_TAG).performClick()
        waitForIdle()
        assertEquals(listOf("v1"), opened)
    }

    @Test
    fun schedule_arrived_cardNamesEveryKinAndOpensTheVisit() = runComposeUiTest {
        val opened = mutableListOf<String>()
        showSchedule(fakeWith(answer(visit("active", "active"), live = true)), opened)

        onNode(onCard("VISIT IN PROGRESS")).assertIsDisplayed()
        onNode(onCard("Auntie Maya is at your place")).assertIsDisplayed()
        onNode(onCard("With Biscuit, Miso")).assertIsDisplayed()
        onNodeWithText("IN PROGRESS").assertIsDisplayed()

        onNodeWithTag(LIVE_VISIT_TAG).performClick()
        waitForIdle()
        assertEquals(listOf("v1"), opened)
    }

    @Test
    fun schedule_departed_fromAnOlderAnswer_cardIsGoneAndTheRowReadsCompletedAndOpens() = runComposeUiTest {
        val opened = mutableListOf<String>()
        showSchedule(fakeWith(answer(visit("active", "ended"), live = false)), opened)

        onNodeWithTag(LIVE_VISIT_TAG).assertDoesNotExist()
        onNodeWithText("IN PROGRESS").assertDoesNotExist()
        onNodeWithText("DEPARTED").assertDoesNotExist()
        onNodeWithText("COMPLETED").assertIsDisplayed()

        onNodeWithText("30 Minute Quick Check").performClick()
        waitForIdle()
        assertEquals(listOf("v1"), opened)
    }

    @Test
    fun schedule_departed_anAnswerStillNamingItLiveDoesNotBringTheCardBack() = runComposeUiTest {
        showSchedule(fakeWith(answer(visit("active", "ended"), live = true)))
        onNodeWithTag(LIVE_VISIT_TAG).assertDoesNotExist()
        onNodeWithText("COMPLETED").assertIsDisplayed()
    }

    @Test
    fun schedule_followsTheVisitWithoutBeingReopened_andTheCardClearsOnDeparted() = runComposeUiTest {
        val fake = fakeWith(
            answer(visit("confirmed", null), live = false),
            answer(visit("enRoute", "enRoute"), live = true),
            answer(visit("active", "active"), live = true),
            // #2123: the Auntie departs and the server answers completed.
            answer(visit("completed", "ended"), live = false),
        )
        showSchedule(fake)
        onNodeWithText("CONFIRMED").assertIsDisplayed()
        onNodeWithTag(LIVE_VISIT_TAG).assertDoesNotExist()

        mainClock.advanceTimeBy(TEST_POLL_MS + 100)
        waitForIdle()
        onNodeWithText("EN ROUTE").assertIsDisplayed()
        onNode(onCard("Auntie Maya is on the way")).assertIsDisplayed()

        mainClock.advanceTimeBy(TEST_POLL_MS)
        waitForIdle()
        onNode(onCard("Auntie Maya is at your place")).assertIsDisplayed()

        mainClock.advanceTimeBy(TEST_POLL_MS)
        waitForIdle()
        onNodeWithTag(LIVE_VISIT_TAG).assertDoesNotExist()
        onNodeWithText("DEPARTED").assertDoesNotExist()
        onNodeWithText("No upcoming bookings").assertIsDisplayed()
        assertEquals(4, bookingsReads(fake))

        // Finished: nothing is due, so the reading stops.
        mainClock.advanceTimeBy(TEST_POLL_MS * 3)
        waitForIdle()
        assertEquals(4, bookingsReads(fake))
    }

    @Test
    fun schedule_aDroppedReReadLeavesTheListAsItIs() = runComposeUiTest {
        val fake = fakeWith(answer(visit("enRoute", "enRoute"), live = true))
        showSchedule(fake)
        onNodeWithText("EN ROUTE").assertIsDisplayed()

        fake.stubError("getMyBookings", IllegalStateException("unavailable"))
        mainClock.advanceTimeBy(TEST_POLL_MS + 100)
        waitForIdle()
        assertTrue(bookingsReads(fake) >= 2, "the re-read should have been tried")
        onNodeWithText("EN ROUTE").assertIsDisplayed()
        onNodeWithText("Couldn't load schedule").assertDoesNotExist()
    }

    @Test
    fun schedule_withNothingDue_readsOnce() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        fake.stub("getMyVisits", buildJsonObject { put("visits", buildJsonArray {}) })
        showSchedule(fake)
        mainClock.advanceTimeBy(TEST_POLL_MS * 4)
        waitForIdle()
        assertEquals(1, bookingsReads(fake))
    }

    @Test
    fun schedule_aVisitUnderWayInAMultiVisitBookingKeepsItsOwnRow() = runComposeUiTest {
        val underWay = visit("active", "active")
        val later = buildJsonObject {
            put("id", "v2")
            put("kinfolkId", "3")
            put("batchId", "batch-1")
            put("status", "confirmed")
            put("serviceLabel", "30 Minute Quick Check")
            put("startTimeMs", now + 86_400_000L)
        }
        val alsoLater = buildJsonObject {
            put("id", "v3")
            put("kinfolkId", "3")
            put("batchId", "batch-1")
            put("status", "confirmed")
            put("serviceLabel", "30 Minute Quick Check")
            put("startTimeMs", now + 2 * 86_400_000L)
        }
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray { add(underWay); add(later); add(alsoLater) })
            put("recent", buildJsonArray {})
        })
        fake.stub("getMyVisits", buildJsonObject { put("visits", buildJsonArray {}) })
        showSchedule(fake)
        onNodeWithText("IN PROGRESS").assertIsDisplayed()
        onNodeWithText("2 visits").assertIsDisplayed()
    }

    // ---- The visit's own screen ----

    private fun ComposeUiTest.showDetail(fake: FakeFunctionsClient, id: String = "v1") {
        setThemedContent {
            KinCareDetailScreen(
                kinCareId = id,
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { now },
                pollMs = TEST_POLL_MS,
            )
        }
        waitForIdle()
    }

    private val stages = listOf(
        Triple("requested", null, "Requested"),
        Triple("confirmed", null, "Confirmed"),
        Triple("enRoute", "enRoute", "En route"),
        Triple("active", "active", "In progress"),
        // #2123: a departed visit from an older answer reads Completed.
        Triple("active", "ended", "Completed"),
        Triple("completed", "ended", "Completed"),
        Triple("cancelled", null, "Cancelled"),
    )

    @Test
    fun detail_opensAtEveryStatus_withItsStatusAndItsKin() {
        stages.forEach { (status, progress, word) ->
            runComposeUiTest {
                val v = visit(status, progress)
                showDetail(fakeWith(answer(v, live = status == "enRoute" || (status == "active" && progress == "active"))))
                onNodeWithText("Booking not found.").assertDoesNotExist()
                onNodeWithText(word).assertIsDisplayed()
                onNodeWithText("Biscuit, Miso").assertIsDisplayed()
            }
        }
    }

    @Test
    fun detail_opensAtEveryStatus_whenTheVisitIsOnNoList() {
        stages.forEach { (status, progress, word) ->
            runComposeUiTest {
                showDetail(fakeWith(answer(visit(status, progress), live = false, listed = false)))
                onNodeWithText("Booking not found.").assertDoesNotExist()
                onNodeWithText(word).assertIsDisplayed()
            }
        }
    }

    @Test
    fun detail_aVisitOfAnotherHousehold_isNotFound() = runComposeUiTest {
        // What the server answers household 3 with: its own visits, nothing more.
        val fake = fakeWith(answer(visit("active", "active", id = "mine"), live = true))
        showDetail(fake, id = "theirs")
        onNodeWithText("Booking not found.").assertIsDisplayed()
        onNodeWithText("30 Minute Quick Check").assertDoesNotExist()
        assertTrue(fake.calls.none { it.first == "getBookingNotes" }, "no notes are asked for a visit that is not ours")
    }

    @Test
    fun detail_followsTheVisitToCompleted_withoutBeingReopened() = runComposeUiTest {
        val fake = fakeWith(
            answer(visit("confirmed", null), live = false),
            answer(visit("enRoute", "enRoute"), live = true),
            answer(visit("active", "active"), live = true),
            // #2123: the Auntie departs and the server answers completed,
            // KinTale or not. There is no Departed step in between.
            answer(visit("completed", "ended"), live = false),
        )
        showDetail(fake)
        onNodeWithText("Confirmed").assertIsDisplayed()

        val seen = mutableListOf<String>()
        listOf("En route", "In progress", "Completed").forEachIndexed { i, word ->
            mainClock.advanceTimeBy(TEST_POLL_MS + if (i == 0) 100 else 0)
            waitForIdle()
            onNodeWithText(word).assertIsDisplayed()
            seen += word
        }
        assertEquals(listOf("En route", "In progress", "Completed"), seen)
        onNodeWithText("Departed").assertDoesNotExist()

        // Finished: nothing is due, so the reading stops.
        val reads = bookingsReads(fake)
        mainClock.advanceTimeBy(TEST_POLL_MS * 3)
        waitForIdle()
        assertEquals(reads, bookingsReads(fake))
    }

    @Test
    fun detail_aDroppedReReadKeepsTheVisitOnScreen() = runComposeUiTest {
        val fake = fakeWith(answer(visit("active", "active"), live = true))
        showDetail(fake)
        onNodeWithText("In progress").assertIsDisplayed()

        fake.stubError("getMyBookings", IllegalStateException("unavailable"))
        mainClock.advanceTimeBy(TEST_POLL_MS + 100)
        waitForIdle()
        onNodeWithText("In progress").assertIsDisplayed()
        onNodeWithText("Booking not found.").assertDoesNotExist()
        onNodeWithText("unavailable").assertDoesNotExist()
    }
}
