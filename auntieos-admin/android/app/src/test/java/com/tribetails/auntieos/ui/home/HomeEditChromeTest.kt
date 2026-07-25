package com.tribetails.auntieos.ui.home

import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 17.3 Dashboard customize mode, the two accessibility halves of it.
 *
 * The edit bar used to FAKE a disabled control: 35% alpha with the click handler
 * simply left off. That is invisible to a screen reader, which read the top card's
 * "move up" as a live button, and to the focus system, which kept stopping on it.
 *
 * And a reorder was silent. The controls named themselves, but nothing narrated the
 * result, so moving a card under TalkBack sounded exactly like nothing happening.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class HomeEditChromeTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun a_control_that_cannot_act_is_disabled_not_merely_dimmed() {
        var upTaps = 0
        var downTaps = 0
        composeRule.setContent {
            AuntieOSTheme {
                // The top card of the board: up is out of bounds, down is not.
                WidgetEditBar(
                    label = "Care flags",
                    canMoveUp = false,
                    canMoveDown = true,
                    onUp = { upTaps += 1 },
                    onDown = { downTaps += 1 },
                    onHide = {},
                )
            }
        }

        composeRule.onNodeWithContentDescription("Move Care flags up").assertIsNotEnabled()
        composeRule.onNodeWithContentDescription("Move Care flags down").assertIsEnabled()
        composeRule.onNodeWithContentDescription("Hide Care flags").assertIsEnabled()

        composeRule.onNodeWithContentDescription("Move Care flags up").performClick()
        composeRule.waitForIdle()
        assertEquals("A disabled control must not run its handler", 0, upTaps)

        composeRule.onNodeWithContentDescription("Move Care flags down").performClick()
        composeRule.waitForIdle()
        assertEquals("The available control still works", 1, downTaps)
    }

    @Test
    fun the_bottom_card_cannot_move_down() {
        composeRule.setContent {
            AuntieOSTheme {
                WidgetEditBar(
                    label = "Supplies tracker",
                    canMoveUp = true,
                    canMoveDown = false,
                    onUp = {},
                    onDown = {},
                    onHide = {},
                )
            }
        }

        composeRule.onNodeWithContentDescription("Move Supplies tracker down").assertIsNotEnabled()
        composeRule.onNodeWithContentDescription("Move Supplies tracker up").assertIsEnabled()
    }

    @Test
    fun a_layout_change_is_announced_through_a_polite_live_region() {
        composeRule.setContent {
            AuntieOSTheme {
                DashboardAnnouncer("Key & code safebox moved down to position 2 of 3.")
            }
        }

        composeRule.onNodeWithContentDescription("Key & code safebox moved down to position 2 of 3.")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
    }

    @Test
    fun the_live_region_exists_before_there_is_anything_to_say() {
        // A live region mounted at the same moment its text arrives is not announced:
        // there is no previous value for TalkBack to see a change against. So the
        // resting state has to be an empty region, not an absent one.
        composeRule.setContent {
            AuntieOSTheme { DashboardAnnouncer("") }
        }

        composeRule.onNode(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
            .assertExists()
    }
}
