package com.tribetails.auntieos.web.ui.components

import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * #854: the desktop save confirmation used to be set on the screen a save
 * navigates away from, in the same code path as the navigation, so the screen
 * (and its local toast state) was disposed before the toast ever painted a
 * frame. [RouteToastHost] fixes this by holding the toast one level above the
 * `when(route)` dispatch every router in the app wraps in it (`App.kt`), so a
 * screen calls `LocalRouteToast.current.show(...)` right before navigating and
 * the confirmation is still there on whatever the router swapped in.
 *
 * This proves the host itself, not a specific screen: a full round trip
 * through a real screen's async save (KinfolkEditScreen, a real local
 * Firestore-REST server, the composition's own dispatcher) was attempted here
 * and dropped - pausing the clock to protect the toast's 4s auto-dismiss
 * either let it fire before any save (autoAdvance on) or never delivered a
 * frame to the initial load at all (autoAdvance off, `advanceTimeBy` in a
 * bounded loop hung outright, on both a real and a blocked network). The
 * five real call sites (KinfolkEditScreen, KinEditScreen, KinTaleComposeScreen,
 * FormSchemaEditorScreen) are one-line substitutions of the existing
 * `showToast(...)` call for `routeToast.show(...)`, listed in the PR diff.
 */
@OptIn(ExperimentalTestApi::class)
class RouteToastHostRenderTest {

    @Test
    fun theConfirmationSurvivesTheComposableItWasShownFromBeingReplaced() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                RouteToastHost {
                    // Stands in for a router's `route` state: onClick shows the
                    // confirmation and swaps the composable in the SAME step, the
                    // exact shape of `showToast(...); onSaved(id)` at every fixed
                    // call site (KinfolkEditScreen:567, KinEditScreen:254, ...).
                    var onDestination by remember { mutableStateOf(false) }
                    if (onDestination) {
                        Text("Destination screen")
                    } else {
                        val routeToast = LocalRouteToast.current
                        PrimaryButton(
                            label = "Save",
                            onClick = {
                                routeToast.show("Saved.", ToastKind.Success)
                                onDestination = true
                            },
                        )
                    }
                }
            }
        }
        waitForIdle()
        assertTrue(onAllNodesWithText("Saved.").fetchSemanticsNodes().isEmpty(), "the toast fired before Save was pressed")

        onNodeWithText("Save").performClick()
        waitForIdle()

        // The source screen is gone - the router moved on...
        assertTrue(onAllNodesWithText("Save").fetchSemanticsNodes().isEmpty(), "the source screen is still on screen")
        onNodeWithText("Destination screen").assertIsDisplayed()
        // ...but the confirmation it set right before navigating is still here.
        onNodeWithText("Saved.").assertIsDisplayed()
    }

    @Test
    fun aSecondIdenticalMessageGetsItsOwnFullDismissWindow() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                RouteToastHost {
                    val routeToast = LocalRouteToast.current
                    PrimaryButton(label = "Show", onClick = { routeToast.show("Saved.", ToastKind.Success) })
                }
            }
        }
        waitForIdle()

        onNodeWithText("Show").performClick()
        waitForIdle()
        onNodeWithText("Saved.").assertIsDisplayed()

        // Most, but not all, of the first toast's 4s auto-dismiss window.
        mainClock.advanceTimeBy(3_000L)
        waitForIdle()

        // A second "Saved." - from another screen's save, moments later - resets
        // the dismiss clock (StatusToast's `resetKey` keys on the host's token,
        // not the message text, so two identical messages don't share a timer).
        onNodeWithText("Show").performClick()
        waitForIdle()

        mainClock.advanceTimeBy(3_000L)
        waitForIdle()
        // 6s since the first Show, but only 3s since the second: still visible.
        assertTrue(onAllNodesWithText("Saved.").fetchSemanticsNodes().isNotEmpty(), "the second toast dismissed early, sharing the first one's timer")

        mainClock.advanceTimeBy(2_000L)
        waitForIdle()
        assertTrue(onAllNodesWithText("Saved.").fetchSemanticsNodes().isEmpty(), "the second toast never auto-dismissed")
    }
}
