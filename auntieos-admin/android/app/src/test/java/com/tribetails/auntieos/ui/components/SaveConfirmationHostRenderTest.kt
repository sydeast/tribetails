package com.tribetails.auntieos.ui.components

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.ThemeMode
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #1009. Robolectric interaction tests for [SaveConfirmationHost], the
 * confirmation surface `AuthenticatedNavHost` mounts once, above `NavHost`.
 *
 * The load-bearing test is [theConfirmationSurvivesTheComposableItWasShownFromBeingReplaced]:
 * every wired call site (`EditKinfolkScreen`, `AddKinScreen`, `KinTaleReportScreen`,
 * ...) calls `confirmation.show(message)` and pops itself off the back stack in
 * the SAME `LaunchedEffect`, the exact shape desktop's `RouteToastHost` test
 * (#1007) proved survives a composable swap. This is that proof for the
 * Navigation Compose host.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SaveConfirmationHostRenderTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun rendersNothing_whenNoMessageHasBeenShown() {
        val state = SaveConfirmationHostState()
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                SaveConfirmationHost(state = state)
            }
        }
        rule.onNodeWithText("Saved Ada Lovelace.").assertDoesNotExist()
    }

    @Test
    fun showDisplaysTheMessage() {
        val state = SaveConfirmationHostState()
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                SaveConfirmationHost(state = state)
            }
        }

        rule.runOnIdle { state.show("Saved Ada Lovelace.") }

        rule.onNodeWithText("Saved Ada Lovelace.").assertIsDisplayed()
    }

    @Test
    fun dismissHidesTheMessage() {
        val state = SaveConfirmationHostState()
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                SaveConfirmationHost(state = state)
            }
        }
        rule.runOnIdle { state.show("Saved Ada Lovelace.") }
        rule.onNodeWithText("Saved Ada Lovelace.").assertIsDisplayed()

        rule.runOnIdle { state.dismiss() }

        rule.onNodeWithText("Saved Ada Lovelace.").assertDoesNotExist()
    }

    /**
     * Reproduces the exact shape every wired call site uses: a click handler
     * that shows the confirmation, THEN swaps the composable it was called
     * from out of composition in the same step (standing in for a real
     * screen's `onSaved()`/`onBack()` popping the back stack). Because
     * [SaveConfirmationHost] is composed as a SIBLING of the screen, not a
     * child of it, the screen going away does not take the confirmation with
     * it - unlike the pre-#1009 world, where there was no host and nothing to
     * lose in the first place.
     */
    @Test
    fun theConfirmationSurvivesTheComposableItWasShownFromBeingReplaced() {
        val state = SaveConfirmationHostState()

        rule.setContent {
            var showEditor by remember { mutableStateOf(true) }
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                Column {
                    SaveConfirmationHost(state = state)
                    if (showEditor) {
                        Button(onClick = {
                            state.show("Saved Ada Lovelace.")
                            showEditor = false
                        }) { Text("Save") }
                    } else {
                        Text("Directory", modifier = Modifier.testTag("directory"))
                    }
                }
            }
        }

        rule.onNodeWithText("Save").performClick()

        // The editor is gone...
        rule.onNodeWithTag("directory").assertIsDisplayed()
        // ...and the confirmation it raised is still standing.
        rule.onNodeWithText("Saved Ada Lovelace.").assertIsDisplayed()
    }

    @Test
    fun aSecondIdenticalMessageStillDisplays_afterTheFirstWasDismissed() {
        val state = SaveConfirmationHostState()
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                SaveConfirmationHost(state = state)
            }
        }

        rule.runOnIdle { state.show("Saved.") }
        rule.onNodeWithText("Saved.").assertIsDisplayed()
        rule.runOnIdle { state.dismiss() }
        rule.onNodeWithText("Saved.").assertDoesNotExist()

        rule.runOnIdle { state.show("Saved.") }

        rule.onNodeWithText("Saved.").assertIsDisplayed()
    }
}
