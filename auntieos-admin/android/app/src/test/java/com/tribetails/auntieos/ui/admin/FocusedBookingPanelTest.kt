package com.tribetails.auntieos.ui.admin

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.ui.admin.scheduling.FocusedBookingStage
import com.tribetails.auntieos.ui.admin.scheduling.LocalBusinessZone
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * #2367: Bookings, opened from a notice about a whole booking the request
 * queue no longer holds. A booked booking shows its banner and its visits,
 * highlighted, each opening its own detail; a gone booking says it is no
 * longer available; a failed lookup offers Retry.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class FocusedBookingPanelTest {

    @get:Rule
    val rule = createComposeRule()

    private val zone = ZoneId.of("America/Chicago")

    private fun visit(id: String, start: String) =
        KinCareSession(id = id, kinfolkId = "fam1", kinCareBatchId = "b7", startTime = start, serviceType = "Drop-in Visit")

    private fun mount(
        stage: FocusedBookingStage,
        opened: MutableList<String> = mutableListOf(),
        dismissed: MutableList<Unit> = mutableListOf(),
        retried: MutableList<Unit> = mutableListOf(),
    ) {
        rule.setContent {
            AuntieOSTheme {
                CompositionLocalProvider(LocalBusinessZone provides zone) {
                    FocusedBookingPanel(
                        stage = stage,
                        catalog = ServiceCatalog(),
                        onOpenVisit = { opened += it },
                        onDismiss = { dismissed += Unit },
                        onRetry = { retried += Unit },
                    )
                }
            }
        }
    }

    @Test
    fun aBookedBookingShowsItsBannerAndHighlightsEachVisit() {
        val opened = mutableListOf<String>()
        mount(
            FocusedBookingStage.Booked(
                listOf(visit("vis_a", "2026-12-03T15:00:00Z"), visit("vis_b", "2026-12-04T15:00:00Z")),
            ),
            opened = opened,
        )
        rule.onNodeWithText("This booking").assertExists()
        rule.onNodeWithText("Its 2 visits are highlighted below.").assertExists()
        rule.onAllNodesWithTag(FOCUSED_BOOKING_VISIT_TAG).assertCountEquals(2)
        rule.onAllNodesWithTag(FOCUSED_BOOKING_VISIT_TAG)[0].assertIsSelected()
        // On the business clock: 15:00Z is 09:00 in Chicago (auntieOS reads 24h, #1828).
        rule.onNodeWithText("Thu, Dec 3 at 09:00").assertExists()

        rule.onAllNodesWithTag(FOCUSED_BOOKING_VISIT_TAG)[1].performClick()
        assertEquals("a highlighted card opens its own detail", listOf("vis_b"), opened)
    }

    @Test
    fun oneVisitIsCountedAsOne() {
        mount(FocusedBookingStage.Booked(listOf(visit("vis_a", "2026-12-03T15:00:00Z"))))
        rule.onNodeWithText("Its visit is highlighted below.").assertExists()
        rule.onAllNodesWithTag(FOCUSED_BOOKING_VISIT_TAG).assertCountEquals(1)
    }

    @Test
    fun aGoneBookingSaysItIsNoLongerAvailable() {
        mount(FocusedBookingStage.Gone)
        rule.onNodeWithText("This booking is no longer available").assertExists()
        rule.onNodeWithText("It was turned down, withdrawn or removed, so there is nothing to open.").assertExists()
        rule.onAllNodesWithTag(FOCUSED_BOOKING_VISIT_TAG).assertCountEquals(0)
        rule.onAllNodesWithText("That request is no longer waiting").assertCountEquals(0)
    }

    @Test
    fun aFailedLookupSaysSoAndOffersRetry() {
        val retried = mutableListOf<Unit>()
        mount(FocusedBookingStage.LookupFailed("You're offline."), retried = retried)
        rule.onNodeWithText("Couldn't look this booking up").assertExists()
        rule.onNodeWithText("You're offline.").assertExists()
        rule.onNodeWithText("Retry").performClick()
        assertEquals(1, retried.size)
    }

    @Test
    fun thePanelIsDrawnOnlyAtStage3() {
        assertTrue(focusedBookingPanelShown(FocusedBookingStage.LookingUp))
        assertTrue(focusedBookingPanelShown(FocusedBookingStage.Gone))
        assertTrue(focusedBookingPanelShown(FocusedBookingStage.LookupFailed("")))
        assertTrue(focusedBookingPanelShown(FocusedBookingStage.Booked(listOf(visit("vis_a", "2026-12-03T15:00:00Z")))))
        assertFalse(focusedBookingPanelShown(FocusedBookingStage.None))
        assertFalse(focusedBookingPanelShown(FocusedBookingStage.Waiting))
        assertFalse(focusedBookingPanelShown(FocusedBookingStage.OpenCard))
    }

    @Test
    fun aVisitWithNoReadableStartSaysDatePending() {
        assertEquals("Date pending", focusedVisitWhen(visit("vis_a", ""), zone))
        assertEquals("Thu, Dec 3 at 09:00", focusedVisitWhen(visit("vis_a", "2026-12-03T15:00:00Z"), zone))
        assertEquals("Thu, Dec 3 at 09:00", focusedVisitWhen(visit("vis_a", "2026-12-03T09:00:00"), zone))
        assertEquals("Thu, Dec 3 at 15:00", focusedVisitWhen(visit("vis_a", "2026-12-03T21:00:00Z"), zone))
    }
}
