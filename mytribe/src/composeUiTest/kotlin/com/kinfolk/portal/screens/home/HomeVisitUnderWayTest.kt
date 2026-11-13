@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.home

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.BOOKINGS_POLL_MS
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

/**
 * #1832 on the MyTribe app's Home: the live card says which of On the way and
 * Arrived it is, names the Kin, opens the visit, and clears when the Auntie
 * leaves; Up next lists the visit with its current status until it is
 * finished. The web mirror is `Home.underWay.test.tsx`.
 *
 * #2123 (operator ruling 2026-11-12): a visit is Completed at departure. The
 * server sends it completed; an older answer's `active` + `ended` pair reads
 * COMPLETED. Nothing on Home says DEPARTED.
 */
class HomeVisitUnderWayTest {
    private val now = kotlin.time.Clock.System.now().toEpochMilliseconds()

    private fun visit(status: String, progress: String?): JsonObject = buildJsonObject {
        put("id", "v1")
        put("kinfolkId", "3")
        put("batchId", "batch-1")
        put("status", status)
        if (progress == null) put("visitProgress", JsonNull) else put("visitProgress", progress)
        put("serviceType", "visit_30")
        put("serviceLabel", "30 Minute Quick Check")
        put("startTimeMs", now - 4 * 60_000L)
        put("sessionId", "vis_v1")
        put("auntieDisplayName", "Maya")
        put("kinNames", buildJsonArray { add("Biscuit") })
    }

    private fun answer(v: JsonObject, live: Boolean): JsonObject = buildJsonObject {
        val finished = v["status"].toString().trim('"') in setOf("completed", "cancelled")
        put("liveVisit", if (live) v else JsonNull)
        put("upcoming", buildJsonArray { if (!finished) add(v) })
        put("recent", buildJsonArray { if (finished) add(v) })
    }

    private fun fakeWith(vararg answers: JsonObject): FakeFunctionsClient {
        val fake = FakeFunctionsClient()
        if (answers.size == 1) fake.stub("getMyBookings", answers[0]) else fake.stubSequence("getMyBookings", *answers)
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {})
        })
        return fake
    }

    private fun ComposeUiTest.show(fake: FakeFunctionsClient, opened: MutableList<String> = mutableListOf()) {
        setThemedContent {
            HomeScreen(
                "The Foster", "3", PortalApi(fake),
                onOpenBooking = { visitId, _ -> opened += visitId },
            )
        }
        waitForIdle()
    }

    private fun onCard(text: String) = hasTestTag(HOME_LIVE_VISIT_TAG) and hasText(text, substring = true)

    @Test
    fun onTheWay_cardSaysSoNamesTheKinAndOpensTheVisit() = runComposeUiTest {
        val opened = mutableListOf<String>()
        show(fakeWith(answer(visit("enRoute", "enRoute"), live = true)), opened)

        onNode(onCard("ON THE WAY")).assertIsDisplayed()
        onNode(onCard("On the way to Biscuit")).assertIsDisplayed()
        onNode(onCard("With Biscuit")).assertDoesNotExist()
        // Up next lists it with its status.
        // (The card's own progress line also says EN ROUTE, so the row is the node without the card's tag.)
        onNode(hasText("EN ROUTE", substring = true) and !hasTestTag(HOME_LIVE_VISIT_TAG)).assertIsDisplayed()

        onNodeWithTag(HOME_LIVE_VISIT_TAG).performClick()
        waitForIdle()
        assertEquals(listOf("v1"), opened)
    }

    @Test
    fun arrived_cardSaysTheAuntieIsWithTheKinAndOpensTheVisit() = runComposeUiTest {
        val opened = mutableListOf<String>()
        show(fakeWith(answer(visit("active", "active"), live = true)), opened)

        onNode(onCard("LIVE")).assertIsDisplayed()
        onNode(onCard("With Biscuit")).assertIsDisplayed()
        onNodeWithText("IN PROGRESS").assertIsDisplayed()

        onNodeWithTag(HOME_LIVE_VISIT_TAG).performClick()
        waitForIdle()
        assertEquals(listOf("v1"), opened)
    }

    @Test
    fun departed_fromAnOlderAnswer_noCard_andTheVisitReadsCompleted() = runComposeUiTest {
        val opened = mutableListOf<String>()
        show(fakeWith(answer(visit("active", "ended"), live = false)), opened)

        onNodeWithTag(HOME_LIVE_VISIT_TAG).assertDoesNotExist()
        onNodeWithText("IN PROGRESS").assertDoesNotExist()
        onNodeWithText("DEPARTED").assertDoesNotExist()
        onNodeWithText("COMPLETED").assertIsDisplayed()

        onNodeWithText("30 Minute Quick Check").performClick()
        waitForIdle()
        assertEquals(listOf("v1"), opened)
    }

    @Test
    fun departed_anAnswerStillNamingItLiveDoesNotBringTheCardBack() = runComposeUiTest {
        show(fakeWith(answer(visit("active", "ended"), live = true)))
        onNodeWithTag(HOME_LIVE_VISIT_TAG).assertDoesNotExist()
        onNodeWithText("COMPLETED").assertIsDisplayed()
    }

    @Test
    fun home_followsTheVisit_andTheCardClearsOnDeparted() = runComposeUiTest {
        val fake = fakeWith(
            answer(visit("confirmed", null), live = false),
            answer(visit("enRoute", "enRoute"), live = true),
            answer(visit("active", "active"), live = true),
            // #2123: the Auntie departs and the server answers completed.
            answer(visit("completed", "ended"), live = false),
        )
        show(fake)
        onNodeWithText("CONFIRMED").assertIsDisplayed()
        onNodeWithTag(HOME_LIVE_VISIT_TAG).assertDoesNotExist()

        mainClock.advanceTimeBy(BOOKINGS_POLL_MS + 100)
        waitForIdle()
        onNode(onCard("On the way to Biscuit")).assertIsDisplayed()

        mainClock.advanceTimeBy(BOOKINGS_POLL_MS)
        waitForIdle()
        onNode(onCard("With Biscuit")).assertIsDisplayed()

        mainClock.advanceTimeBy(BOOKINGS_POLL_MS)
        waitForIdle()
        onNodeWithTag(HOME_LIVE_VISIT_TAG).assertDoesNotExist()
        onNodeWithText("DEPARTED").assertDoesNotExist()
        onNodeWithText("IN PROGRESS").assertDoesNotExist()
        assertEquals(4, fake.calls.count { it.first == "getMyBookings" })

        // Finished: nothing is due, so Home stops reading.
        mainClock.advanceTimeBy(BOOKINGS_POLL_MS * 2)
        waitForIdle()
        assertEquals(4, fake.calls.count { it.first == "getMyBookings" })
    }
}
