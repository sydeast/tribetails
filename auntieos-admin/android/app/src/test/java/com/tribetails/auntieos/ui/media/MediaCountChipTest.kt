package com.tribetails.auntieos.ui.media

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The media gallery's top-bar count chip (mock `.count`, the SUGGESTION the
 * operator approved on 2026-08-09).
 *
 * The interesting half is the GATE, not the wording: a count chip must never
 * show a number while the stream is still loading or after it failed, because a
 * "0 files" drawn over an unread collection is the same fabricated claim the web
 * StatCard was rewritten to make impossible. [mediaCountChipLabel] is pure so
 * that gate is testable without a ViewModel.
 */
class MediaCountChipLabelTest {

    @Test
    fun `pluralises a real count`() {
        assertEquals("3 files", mediaCountChipLabel(isLoading = false, error = null, count = 3))
    }

    @Test
    fun `singularises a one-file gallery`() {
        assertEquals("1 file", mediaCountChipLabel(isLoading = false, error = null, count = 1))
    }

    @Test
    fun `claims no number while the stream is still loading`() {
        assertNull(mediaCountChipLabel(isLoading = true, error = null, count = 0))
    }

    @Test
    fun `claims no number while loading even if a stale count is in hand`() {
        assertNull(mediaCountChipLabel(isLoading = true, error = null, count = 7))
    }

    @Test
    fun `claims no number when the read failed, because unknown is not zero`() {
        assertNull(mediaCountChipLabel(isLoading = false, error = "permission-denied", count = 0))
    }

    @Test
    fun `claims no number when the read failed even if a stale count is in hand`() {
        assertNull(mediaCountChipLabel(isLoading = false, error = "permission-denied", count = 7))
    }

    @Test
    fun `shows nothing for a proven-empty gallery, because the empty state already says so`() {
        assertNull(mediaCountChipLabel(isLoading = false, error = null, count = 0))
    }
}

/** Renders the real chip composable to prove the label reaches the screen. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MediaCountChipRenderTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun `renders the label it is given`() {
        composeRule.setContent {
            AuntieOSTheme {
                MediaCountChip(label = "4 files")
            }
        }
        composeRule.onNodeWithText("4 files").assertIsDisplayed()
    }
}
