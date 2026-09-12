package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * ISSUE #755: the KinCare types editor on the phone, laid out as its mock.
 * Deliberately ViewModel-free, the [AdminSettingsSectionNavTest] harness: the
 * panel is state-hoisted, so a fake `onSettingsChange` captures what a Save
 * would hand the diff-and-save without standing up AdminSettingsViewModel.
 *
 * The harness scrolls, as the real section detail does (`AdminSettingsSectionNav`
 * wraps it in `verticalScroll`): the save bar sits under two panels, below the
 * Robolectric viewport fold, and an injected tap only lands on what is on
 * screen. Every control is scrolled to before it is tapped.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class KinCareTypesPanelTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun setContent(initial: BusinessSettings, onSave: (BusinessSettings) -> Unit = {}) {
        composeRule.setContent {
            AuntieOSTheme {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    KinCareTypesPanel(settings = initial, isLoading = false, onSettingsChange = onSave)
                }
            }
        }
    }

    @Test
    fun `lays out the rows panel, the preview of the booking label, and the save bar`() {
        setContent(BusinessSettings(serviceRates = mapOf("Walk" to "10.00")))
        composeRule.onNodeWithText("Your KinCare types").assertExists()
        composeRule.onNodeWithText("1 type").assertExists()
        composeRule.onNodeWithText("How it looks on the booking screen").assertExists()
        // The preview is the booking wizard's own label for the type.
        composeRule.onNodeWithText("Walk · \$10.00").assertExists()
        composeRule.onNodeWithText("Save KinCare types").assertExists()
        composeRule.onNodeWithText("Unsaved changes".uppercase()).assertDoesNotExist()
    }

    @Test
    fun `removing a type and saving hands back the settings without it`() {
        var saved: BusinessSettings? = null
        setContent(
            BusinessSettings(serviceRates = mapOf("Walk" to "10.00", "Overnight" to "80.00")),
            onSave = { saved = it },
        )
        composeRule.onNodeWithContentDescription("Remove Walk").performScrollTo().performClick()
        composeRule.onNodeWithText("Unsaved changes".uppercase()).assertExists()
        composeRule.onNodeWithText("Save KinCare types").performScrollTo().performClick()
        assertEquals(mapOf("Overnight" to "80.00"), saved?.serviceRates)
        assertEquals(emptyMap<String, String>(), saved?.serviceDurations)
    }

    @Test
    fun `Add KinCare type appends a blank row that never reads dirty on its own`() {
        var saved: BusinessSettings? = null
        setContent(BusinessSettings(), onSave = { saved = it })
        composeRule.onNodeWithText("No KinCare types yet. Add one below.").assertExists()
        composeRule.onNodeWithText("No KinCare types yet. Add one above.").assertExists()
        composeRule.onNodeWithText("Add KinCare type").performScrollTo().performClick()
        composeRule.onNodeWithText("No KinCare types yet. Add one below.").assertDoesNotExist()
        composeRule.onNodeWithContentDescription("Remove").assertExists()
        // A blank row folds to nothing, so there is nothing to save yet.
        composeRule.onNodeWithText("Unsaved changes".uppercase()).assertDoesNotExist()
        assertNull(saved)
    }
}
