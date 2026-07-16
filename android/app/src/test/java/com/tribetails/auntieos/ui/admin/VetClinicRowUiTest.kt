package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.VetClinic
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * UI interaction test for the vet-clinic row (spec 29 item 8): delete is a
 * destructive hard-delete, so it must take a two step confirm. Verifies the first
 * Delete tap only reveals the confirm (no delete), Cancel aborts, and only
 * Delete then Confirm fires onDelete.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class VetClinicRowUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val clinic = VetClinic(id = "c1", name = "Creekside", phone = "555", address = "1 Ln")

    @Test
    fun `delete takes a two step confirm`() {
        var deleted = false
        composeRule.setContent {
            AuntieOSTheme {
                VetClinicRow(clinic = clinic, householdCount = 0, onSave = {}, onDelete = { deleted = true })
            }
        }

        // First tap reveals the confirm and does NOT delete. (#6: delete is now an icon button.)
        composeRule.onNodeWithContentDescription("Delete clinic").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Confirm delete").assertIsDisplayed()
        assertFalse(deleted)

        // Cancel aborts.
        composeRule.onNodeWithText("Cancel").performClick()
        composeRule.waitForIdle()
        assertFalse(deleted)

        // Delete then Confirm fires onDelete exactly once.
        composeRule.onNodeWithContentDescription("Delete clinic").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Confirm delete").performClick()
        composeRule.waitForIdle()
        assertTrue(deleted)
    }
}
