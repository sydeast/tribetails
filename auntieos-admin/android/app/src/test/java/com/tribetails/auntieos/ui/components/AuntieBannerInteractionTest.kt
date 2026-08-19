package com.tribetails.auntieos.ui.components

import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.requestFocus
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
 * this proves with a `contentDescription`-labelled close glyph, the system back
 * button (scoped to `dismissible` only, never to a pre-existing `onDismiss`
 * banner that never asked for back-press behavior), and a best-effort
 * `FocusManager.moveFocus` handoff on dismiss, the platform-native equivalents
 * named in #444's "Work" section and the follow-up review on it.
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

    /**
     * THE BOUNDARY, PINNED IN BOTH DIRECTIONS.
     *
     * A control [BackHandler] registers OUTSIDE (before) the banner in each
     * case, so it is added to the dispatcher first. Per [BackHandler]'s
     * most-recently-added-first resolution, it only fires if the banner's own
     * [BackHandler] did not consume the press first, an outer OnBackPressed
     * that fires (or does not) is direct proof of what the banner did with
     * back, not an inference from a side effect. `onBackPressedDispatcher.
     * onBackPressed()` is not called on a banner with neither `dismissible`
     * nor `onDismiss` here; that banner never registers a [BackHandler] at
     * all (`enabled = dismissible` is `false`), so there is nothing extra a
     * third case would prove beyond what these two already pin.
     */
    @Test
    fun `a banner with onDismiss but not dismissible does not consume back press`() {
        var outerBackFired = false
        var cleared = false
        composeRule.setContent {
            AuntieOSTheme {
                Column {
                    BackHandler { outerBackFired = true }
                    AuntieBanner(title = "Save failed", onDismiss = { cleared = true }) {}
                }
            }
        }

        composeRule.onNodeWithContentDescription("Dismiss").assertIsDisplayed()

        composeRule.activity.onBackPressedDispatcher.onBackPressed()
        composeRule.waitForIdle()

        assertTrue("the outer back handler must fire; the banner must not eat back press", outerBackFired)
        assertFalse("onDismiss must not fire from back press when dismissible is false", cleared)
        composeRule.onNodeWithText("Save failed").assertIsDisplayed()
    }

    @Test
    fun `a dismissible banner consumes back press before an outer handler sees it`() {
        var outerBackFired = false
        composeRule.setContent {
            AuntieOSTheme {
                Column {
                    BackHandler { outerBackFired = true }
                    AuntieBanner(title = "Archived", dismissible = true) {}
                }
            }
        }

        composeRule.activity.onBackPressedDispatcher.onBackPressed()
        composeRule.waitForIdle()

        assertFalse("a dismissible banner must consume back press itself", outerBackFired)
        composeRule.onNodeWithText("Archived").assertDoesNotExist()
    }

    /**
     * The best-effort half of #444's follow-up review: on dismiss, input (and,
     * per Compose's documented accessibility-delegate behavior, TalkBack)
     * focus moves forward to whatever comes after the banner, rather than
     * being dropped. `requestFocus()` here stands in for a hardware-keyboard
     * or TalkBack-linear-navigation user who already carries Compose input
     * focus on the close button before dismissing it.
     */
    @Test
    fun `dismissing a focused banner hands focus to whatever comes after it`() {
        composeRule.setContent {
            AuntieOSTheme {
                Column {
                    AuntieBanner(title = "Archived", dismissible = true) {}
                    Text("Next item", modifier = Modifier.focusable())
                }
            }
        }

        composeRule.onNodeWithContentDescription("Dismiss").requestFocus()
        composeRule.waitForIdle()

        composeRule.onNodeWithContentDescription("Dismiss").performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithText("Next item").assertIsFocused()
    }
}
