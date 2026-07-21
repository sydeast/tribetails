package com.tribetails.auntieos.web.ui.kintales

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.screens.kintales.KinHeadingText
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test

/**
 * Slice 9 desktop compose UI test for the per-kin checklist heading
 * (KinTaleReportScreen ChecklistSections, spec 11 item 4.1). Renders the real
 * [KinHeadingText] shim (same kinHeading join + Text the screen draws) and asserts
 * the joined "Name · Species · Breed" displays on a resolved kin, and the raw
 * kinId displays when the kin can't be resolved (never an invented name).
 */
@OptIn(ExperimentalTestApi::class)
class KinHeadingRenderTest {

    @Test
    fun rendersJoinedNameSpeciesBreed() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinHeadingText(
                    kinId = "k1",
                    kinById = mapOf("k1" to Kin(_id = "k1", name = "Biscuit", species = "Dog", breed = "Labrador")),
                )
            }
        }
        onNodeWithText("Biscuit · Dog · Labrador").assertIsDisplayed()
    }

    @Test
    fun fallsBackToRawIdWhenKinMissing() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinHeadingText(kinId = "k-unknown", kinById = emptyMap())
            }
        }
        onNodeWithText("k-unknown").assertIsDisplayed()
    }
}
