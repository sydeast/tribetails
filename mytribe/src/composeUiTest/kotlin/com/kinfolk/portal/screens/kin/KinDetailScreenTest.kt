@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.kin

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinStatus
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test

class KinDetailScreenTest {

    private fun kin(status: KinStatus) = Kin(
        id = "k1",
        name = "Biscuit",
        species = "Dog",
        breed = "Corgi",
        ageYears = 4.0,
        photoUrl = null,
        status = status,
        feedingInstructions = "Two cups, morning and night",
        walkingInstructions = null,
        medications = null,
        allergies = null,
        emergencyNotes = null,
        sitterNotes = null,
    )

    @Test
    fun active_showsMarkAction() = runComposeUiTest {
        setThemedContent {
            KinDetailScreen("The Foster", kin(KinStatus.Active), onBack = {})
        }
        waitForIdle()
        onNodeWithText("Mark No Longer With Us").assertIsDisplayed()
    }

    @Test
    fun archived_showsBandAndRestore() = runComposeUiTest {
        setThemedContent {
            KinDetailScreen("The Foster", kin(KinStatus.NoLongerWithUs), onBack = {})
        }
        waitForIdle()
        onNodeWithText("In our hearts").assertIsDisplayed()
        onNodeWithText("Restore as Active").assertIsDisplayed()
    }
}
