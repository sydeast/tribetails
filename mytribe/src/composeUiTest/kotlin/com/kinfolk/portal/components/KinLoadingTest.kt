@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.components

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The 2026-09-12 ruling on the portal Android app.
 *
 * The clock is driven manually (`mainClock.autoAdvance = false`) because
 * [KinSpinner] runs an infinite transition: with autoAdvance on, `waitForIdle`
 * never returns, since the composition is never idle. Turning it off is what
 * makes a 10-second threshold testable in milliseconds of real time, and it is
 * also the only way to assert the BEFORE state -- that nothing is offered at
 * 9.999s -- which is half of what the threshold means.
 */
class KinLoadingTest {

    @Test
    fun a_pending_read_shows_the_cue_and_the_sentence() = runComposeUiTest {
        mainClock.autoAdvance = false
        setThemedContent { KinLoading(text = "Loading your schedule…", onSync = {}) }
        mainClock.advanceTimeBy(16L)

        // The words are not optional: four sections of Home wait at once, and a
        // bare ring cannot say which of them this is.
        onNodeWithText("Loading your schedule…").assertIsDisplayed()
    }

    /**
     * 9.4s: the slowest cold start ever measured on this project, and so the
     * longest wait that must still read as healthy.
     *
     * NOT `SLOW_WAIT_MS - 1`. `advanceTimeBy` rounds up to a whole number of
     * 16ms frames, so 9999ms actually advances 625 frames -- exactly 10000ms --
     * and fires the very threshold the assertion is trying to stay under. The
     * exact boundary belongs in `SlowWaitTest`, which is pure arithmetic with
     * no frame quantisation in the way; what a UI test can honestly assert is a
     * comfortable before and a comfortable after.
     */
    @Test
    fun no_sync_is_offered_during_a_normal_cold_start() = runComposeUiTest {
        mainClock.autoAdvance = false
        setThemedContent { KinLoading(text = "Loading your schedule…", onSync = {}) }
        mainClock.advanceTimeBy(9_400L)

        onNodeWithText("Tap to sync").assertDoesNotExist()
        onNodeWithText("Loading your schedule…").assertIsDisplayed()
    }

    @Test
    fun past_the_threshold_it_offers_tap_to_sync_and_keeps_waiting() = runComposeUiTest {
        mainClock.autoAdvance = false
        setThemedContent { KinLoading(text = "Loading your schedule…", onSync = {}) }
        mainClock.advanceTimeBy(SLOW_WAIT_MS + 16L)

        onNodeWithText("Tribe Tails has not answered yet.").assertIsDisplayed()
        onNodeWithText("Tap to sync").assertIsDisplayed()
        // Still pessimistic. The read has not ended, so the cue has not either,
        // and nothing has been painted as though the wait were over.
        onNodeWithText("Loading your schedule…").assertIsDisplayed()
    }

    @Test
    fun tapping_sync_retries_and_says_what_it_is_doing() = runComposeUiTest {
        var asked = 0
        mainClock.autoAdvance = false
        setThemedContent { KinLoading(text = "Loading your schedule…", onSync = { asked += 1 }) }
        mainClock.advanceTimeBy(SLOW_WAIT_MS + 16L)

        onNodeWithText("Tap to sync").performClick()
        mainClock.advanceTimeBy(16L)

        assertEquals(1, asked)
        // The clock restarted, so the offer is withdrawn until this attempt has
        // also run long.
        onNodeWithText("Tap to sync").assertDoesNotExist()

        mainClock.advanceTimeBy(SLOW_WAIT_MS + 16L)
        onNodeWithText("Asked again. Still waiting on Tribe Tails.").assertIsDisplayed()
        onNodeWithText("Ask again").assertIsDisplayed()
    }

    /**
     * An offline wait is not a slow server. It keeps the cue -- it is still a
     * wait -- but must never be handed a Sync button that fails the moment it
     * is pressed.
     */
    @Test
    fun offline_never_escalates() = runComposeUiTest {
        mainClock.autoAdvance = false
        setThemedContent {
            KinLoading(text = "Loading your schedule…", online = false, onSync = {})
        }
        mainClock.advanceTimeBy(SLOW_WAIT_MS * 6)

        onNodeWithText("Tap to sync").assertDoesNotExist()
        onNodeWithText("Tribe Tails has not answered yet.").assertDoesNotExist()
        onNodeWithText("Loading your schedule…").assertIsDisplayed()
    }
}
