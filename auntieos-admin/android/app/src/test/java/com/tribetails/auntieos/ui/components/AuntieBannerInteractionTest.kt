package com.tribetails.auntieos.ui.components

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric Compose UI coverage for #444: `AuntieBanner`'s `dismissible` prop,
 * mirroring `Banner.test.tsx`'s `describe('Banner dismissible (#406)')` on web
 * (PR #419).
 *
 * What web proved with a labelled `<button>`, `Escape`, and `document.activeElement`
 * this proves with a `contentDescription`-labelled close glyph and the system back
 * button, the two platform-native equivalents named in #444's "Work" section.
 * Web additionally restores DOM focus on dismiss; Android has no keyboard-focus
 * analogue for a banner dismissed by touch or TalkBack swipe, and #444 does not
 * ask for one, so there is nothing to assert here for that half of PR #419.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AuntieBannerInteractionTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun `dismissible with no onDismiss shows a labelled close button and hides on click`() {
        composeRule.setContent {
            AuntieOSTheme {
                AuntieBanner(title = "Archived", dismissible = true) {}
            }
        }

        composeRule.onNodeWithText("Archived").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Dismiss").assertIsDisplayed()

        composeRule.onNodeWithContentDescription("Dismiss").performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithText("Archived").assertDoesNotExist()
    }

    @Test
    fun `not dismissible and no onDismiss renders no close button`() {
        composeRule.setContent {
            AuntieOSTheme {
                AuntieBanner(title = "Shared vet directory") {}
            }
        }

        composeRule.onNodeWithText("Shared vet directory").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Dismiss").assertDoesNotExist()
    }

    @Test
    fun `onDismiss alone still implies dismissible and still fires the callback`() {
        var cleared = false
        composeRule.setContent {
            AuntieOSTheme {
                AuntieBanner(title = "Save failed", onDismiss = { cleared = true }) {}
            }
        }

        composeRule.onNodeWithContentDescription("Dismiss").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Dismiss").performClick()
        composeRule.waitForIdle()

        assertTrue(cleared)
        composeRule.onNodeWithText("Save failed").assertDoesNotExist()
    }

    @Test
    fun `clicking dismiss on a dismissible banner also calls onDismiss when given`() {
        var calls = 0
        composeRule.setContent {
            AuntieOSTheme {
                AuntieBanner(title = "Archived", dismissible = true, onDismiss = { calls++ }) {}
            }
        }

        composeRule.onNodeWithContentDescription("Dismiss").performClick()
        composeRule.waitForIdle()

        assertEquals(1, calls)
    }

    @Test
    fun `back press dismisses a dismissible banner`() {
        composeRule.setContent {
            AuntieOSTheme {
                AuntieBanner(title = "Archived", dismissible = true) {}
            }
        }

        composeRule.onNodeWithText("Archived").assertIsDisplayed()

        composeRule.activity.onBackPressedDispatcher.onBackPressed()
        composeRule.waitForIdle()

        composeRule.onNodeWithText("Archived").assertDoesNotExist()
    }

    @Test
    fun `back press also fires onDismiss on a dismissible banner`() {
        var calls = 0
        composeRule.setContent {
            AuntieOSTheme {
                AuntieBanner(title = "Archived", dismissible = true, onDismiss = { calls++ }) {}
            }
        }

        composeRule.activity.onBackPressedDispatcher.onBackPressed()
        composeRule.waitForIdle()

        assertEquals(1, calls)
    }
}
