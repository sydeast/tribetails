package com.tribetails.auntieos.web.ui.components

import androidx.compose.material3.Text
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A dialog whose body is taller than the card must still show its footer. The
 * body scrolls; the footer's buttons stay on screen and take a click. Before the
 * fix the scrolling body took the card's whole height and pushed the footer
 * below the clip, so Save / Create could not be pressed on a long form.
 */
@OptIn(ExperimentalTestApi::class)
class AuntieDialogFooterRenderTest {

    @Test
    fun aTallBodyScrollsAndTheFooterStaysPressable() = runDesktopComposeUiTest {
        var pressed = 0
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AuntieDialog(
                    visible = true,
                    title = "Tall dialog",
                    onDismiss = {},
                    footer = { PrimaryButton(label = "Save it", onClick = { pressed++ }) },
                ) {
                    repeat(80) { Text("Row $it") }
                }
            }
        }
        waitForIdle()
        onNodeWithText("Row 0").assertIsDisplayed()
        onNodeWithText("Save it").assertIsDisplayed().performClick()
        waitForIdle()
        assertEquals(1, pressed)
    }
    @Test
    fun aTallBodyWithAHintKeepsHeaderAndFooterOnScreen() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AuntieDialog(
                    visible = true,
                    title = "Tall dialog",
                    hint = "A hint line",
                    onDismiss = {},
                    footer = { PrimaryButton(label = "Save it", onClick = {}) },
                ) {
                    repeat(80) { Text("Row $it") }
                }
            }
        }
        waitForIdle()
        onNodeWithText("Tall dialog").assertIsDisplayed()
        onNodeWithText("Save it").assertIsDisplayed()
        onNodeWithText("A hint line").assertIsDisplayed()
    }
    @Test
    fun aShortBodyStillShowsTheFooterAndHugsItsContent() = runDesktopComposeUiTest {
        var cancelled = 0
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.LIGHT) {
                AuntieDialog(
                    visible = true,
                    title = "Short dialog",
                    onDismiss = {},
                    footer = {
                        PrimaryButton(label = "Cancel it", onClick = { cancelled++ })
                        PrimaryButton(label = "Create it", onClick = {})
                    },
                ) {
                    Text("Only row")
                }
            }
        }
        waitForIdle()
        onNodeWithText("Only row").assertIsDisplayed()
        onNodeWithText("Create it").assertIsDisplayed()
        onNodeWithText("Cancel it").assertIsDisplayed().performClick()
        assertEquals(1, cancelled)
        // A one-row dialog must hug its content, not stretch to the 760dp cap.
        val gap = onNodeWithText("Create it").getUnclippedBoundsInRoot().top -
            onNodeWithText("Only row").getUnclippedBoundsInRoot().bottom
        assertTrue(gap < 120.dp, "body-to-footer gap was $gap")
    }
}
