package com.tribetails.auntieos.web.screens.booking

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.screens.notifications.visitRequestKey
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #2367: Open on a whole-booking notice lands on Bookings for that booking.
 * Its request has left the queue, so the household's visits are looked up: a
 * booked booking shows "This booking" over its highlighted visit cards, and a
 * booking with no visits says it is no longer available.
 */
@OptIn(ExperimentalTestApi::class)
class BookingFocusLookupRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun visit(id: String, kinfolkId: String, batchId: String, start: String) = KinCareSession(
        _id = id,
        kinfolkId = kinfolkId,
        kinfolkName = "The Wrens",
        kinCareBatchId = batchId,
        startTime = start,
        status = "SCHEDULED",
    )

    private fun seed(sessions: List<KinCareSession>) {
        JvmFirestoreFixtures.businessSettings = BusinessSettings(timeZone = "America/Chicago")
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1", firstName = "Ada", lastName = "Wren"))
        // The request has left the queue: booked, or turned down.
        JvmFirestoreFixtures.incomingKinCares = emptyList()
        JvmFirestoreFixtures.bookingRequests = emptyList()
        JvmFirestoreFixtures.sessions = sessions
        // The fixture answers every household with this list; the lookup's own filter must hold.
        JvmFirestoreFixtures.sessionsForKinfolk = sessions
    }

    private fun androidx.compose.ui.test.ComposeUiTest.showFocused(onConsumed: () -> Unit) {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                // As the App holds it: the key is cleared once Bookings consumes it.
                var key by remember { mutableStateOf<String?>(visitRequestKey("kf1", "b1")) }
                BookingScreen(focusRequestKey = key, onFocusRequestConsumed = { key = null; onConsumed() })
            }
        }
    }

    private fun androidx.compose.ui.test.ComposeUiTest.highlighted() =
        onAllNodesWithTag(BOOKING_HIGHLIGHT_TAG, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun androidx.compose.ui.test.ComposeUiTest.shows(text: String) =
        onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun aBookedBookingShowsItsBannerAndHighlightsItsVisits() = runDesktopComposeUiTest {
        seed(
            listOf(
                visit("vis_1", "kf1", "b1", "2026-11-19T17:00:00Z"),
                visit("vis_2", "kf1", "b1", "2026-11-20T17:00:00Z"),
                // Another household's booking with the same request id, and another booking of kf1.
                visit("vis_other_home", "kf2", "b1", "2026-11-21T17:00:00Z"),
                visit("vis_other_booking", "kf1", "b9", "2026-11-22T17:00:00Z"),
            ),
        )
        var consumed = 0
        showFocused { consumed++ }

        waitUntil(timeoutMillis = 10_000) { shows(BOOKING_FOUND_TITLE) && highlighted() == 2 }
        assertTrue(shows("Its 2 visits are highlighted below."))
        assertEquals(2, highlighted())
        assertEquals(1, consumed, "the focus is consumed once")
        assertTrue(!shows(BOOKING_GONE_TITLE))

        // Dismiss clears the banner and the highlight.
        onNodeWithContentDescription("Dismiss", useUnmergedTree = true).performClick()
        waitForIdle()
        assertEquals(0, highlighted())
        assertTrue(!shows("Its 2 visits are highlighted below."))
    }

    @Test
    fun aBookingWithNoVisitsIsNoLongerAvailable() = runDesktopComposeUiTest {
        // Only another household carries this request id: kf1's booking is gone.
        seed(listOf(visit("vis_other_home", "kf2", "b1", "2026-11-21T17:00:00Z")))
        var consumed = 0
        showFocused { consumed++ }

        waitUntil(timeoutMillis = 10_000) { shows(BOOKING_GONE_TITLE) }
        assertTrue(shows(BOOKING_GONE_BODY))
        assertEquals(0, highlighted())
        assertEquals(1, consumed)
        assertTrue(!shows(BOOKING_FOUND_TITLE))
    }
}
