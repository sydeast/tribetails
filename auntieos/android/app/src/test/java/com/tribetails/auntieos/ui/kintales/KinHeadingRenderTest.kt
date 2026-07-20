package com.tribetails.auntieos.ui.kintales

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Slice 9 Robolectric compose UI test for the per-kin checklist heading
 * (KinTaleReportScreen, spec 11 item 4.1). Renders the real [KinHeadingText] shim
 * and asserts the joined "Name · Species · Breed" displays on a resolved kin, and
 * the raw kin id displays when the kin has no name (never an invented pet name).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class KinHeadingRenderTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun `renders joined name species breed`() {
        composeRule.setContent {
            AuntieOSTheme {
                KinHeadingText(Kin(id = "kin1", name = "Biscuit", species = "Dog", breed = "Labrador"))
            }
        }
        composeRule.onNodeWithText("Biscuit · Dog · Labrador").assertIsDisplayed()
    }

    @Test
    fun `falls back to raw id when name blank`() {
        composeRule.setContent {
            AuntieOSTheme {
                KinHeadingText(Kin(id = "kin-unknown", name = "", species = "Dog", breed = "Poodle"))
            }
        }
        composeRule.onNodeWithText("kin-unknown").assertIsDisplayed()
    }
}
