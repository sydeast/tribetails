package com.tribetails.auntieos.ui.components

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.ThemeMode
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric interaction tests for [AuntieScreenScaffold].
 *
 * Verifies:
 *  - title + content render together when title provided (AuntieTopBar wired)
 *  - content renders without top bar when title == null
 *  - backgroundFullBleed = true does not crash and still shows content
 *  - imePaddingEnabled = true does not crash and still shows content
 *
 * Matches Robolectric pilot idiom from AuntieToggleInteractionTest.kt
 * (SDK 35, ComponentActivity, junit4.v2 createAndroidComposeRule).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AuntieScreenScaffoldTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun rendersTitleAndContent_whenTitleProvided() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                AuntieScreenScaffold(title = "Settings") {
                    Text("body", modifier = Modifier.testTag("body"))
                }
            }
        }
        rule.onNodeWithText("Settings").assertIsDisplayed()
        rule.onNodeWithTag("body").assertIsDisplayed()
    }

    @Test
    fun rendersContentWithoutTopBar_whenTitleNull() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                AuntieScreenScaffold(title = null) {
                    Text("only-body", modifier = Modifier.testTag("only-body"))
                }
            }
        }
        rule.onNodeWithTag("only-body").assertIsDisplayed()
    }

    @Test
    fun fullBleedFlag_doesNotCrash_andShowsContent() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                AuntieScreenScaffold(
                    title = "Home",
                    backgroundFullBleed = true,
                ) {
                    Text("home-body", modifier = Modifier.testTag("home-body").fillMaxSize())
                }
            }
        }
        rule.onNodeWithText("Home").assertIsDisplayed()
        rule.onNodeWithTag("home-body").assertIsDisplayed()
    }

    @Test
    fun imePaddingFlag_doesNotCrash_andShowsContent() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                AuntieScreenScaffold(
                    title = "Compose",
                    imePaddingEnabled = true,
                ) {
                    Text("ime-body", modifier = Modifier.testTag("ime-body"))
                }
            }
        }
        rule.onNodeWithTag("ime-body").assertIsDisplayed()
    }
}
