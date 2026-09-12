package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric compose UI test for the Android Business Settings list -> detail
 * drill-down [AdminSettingsSectionNav]. This is the mobile answer to the web
 * admin's section nav: a phone can't take the left rail, so the screen is a
 * tappable list of sections that opens ONE detail panel at a time, killing the
 * old ~2500dp verticalScroll.
 *
 * Deliberately ViewModel-free: the shell is state-hoisted, so these tests drive
 * it with a fake `detail` slot ("PANEL::<title>") and a marker `listHeader`,
 * exercising the navigation itself without standing up AdminSettingsViewModel.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AdminSettingsSectionNavTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun setContent() {
        composeRule.setContent {
            AuntieOSTheme {
                var selected by remember { mutableStateOf<SettingsSection?>(null) }
                AdminSettingsSectionNav(
                    selected = selected,
                    onSelect = { selected = it },
                    onBackToList = { selected = null },
                    detail = { section -> Text("PANEL::${section.title}") },
                    listHeader = { Text("LIST_HEADER") },
                )
            }
        }
    }

    @Test
    fun `list shows the header and every section row`() {
        setContent()
        composeRule.onNodeWithText("LIST_HEADER").assertExists()
        // Every section is reachable from the list (assertExists, not
        // assertIsDisplayed: the lower rows sit below the test viewport fold).
        SettingsSection.entries.forEach { section ->
            composeRule.onNodeWithText(section.title).assertExists()
        }
    }

    // Issue #755: the list is the settings mock's `.secnav`, an icon and a
    // label per row. The blurb is not drawn, and the toggle section carries
    // the mock's title.
    @Test
    fun `list rows are label only, with the mock's Scheduling title`() {
        setContent()
        SettingsSection.entries.forEach { section ->
            composeRule.onNodeWithText(section.blurb).assertDoesNotExist()
        }
        composeRule.onNodeWithText("Scheduling").assertExists()
        composeRule.onNodeWithText("Booking behavior").assertDoesNotExist()
    }

    @Test
    fun `tapping a section opens only its detail panel`() {
        setContent()
        // Branding is the first row, so it is on-screen and tappable without a scroll.
        composeRule.onNodeWithText("Branding").performClick()

        composeRule.onNodeWithText("PANEL::Branding").assertIsDisplayed()
        composeRule.onNodeWithText("All settings").assertIsDisplayed()
        // The list (its header) is gone while a section is open.
        composeRule.onNodeWithText("LIST_HEADER").assertDoesNotExist()
    }

    @Test
    fun `the All settings affordance returns to the list`() {
        setContent()
        composeRule.onNodeWithText("Branding").performClick()
        composeRule.onNodeWithText("All settings").performClick()

        composeRule.onNodeWithText("LIST_HEADER").assertExists()
        composeRule.onNodeWithText("PANEL::Branding").assertDoesNotExist()
    }
}
