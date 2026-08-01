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
 * UI interaction test for the vet-clinic row (spec 29 item 8, punchlist B4).
 *
 * The destructive action RETIRES (archives) rather than hard-deleting, because
 * households point at a clinic by id with no referential integrity, so removing
 * the row would strand them. It still takes a two step confirm: retiring pulls
 * a clinic out of every picker, which is worth a deliberate second tap even
 * though it is reversible.
 *
 * The usage badge is the other thing pinned here: an unknown count must read as
 * "checking", never as zero, because the control beside it retires the clinic.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class VetClinicRowUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val clinic = VetClinic(id = "c1", name = "Creekside", phone = "555", address = "1 Ln")

    /**
     * The control RETIRES rather than deletes, and its label says so. A hard
     * delete would strand every household whose `vetClinicId` points here.
     */
    @Test
    fun `retire takes a two step confirm`() {
        var retired = false
        composeRule.setContent {
            AuntieOSTheme {
                VetClinicRow(clinic = clinic, usage = VetClinicUsage(), onSave = {}, onRetire = { retired = true })
            }
        }

        // First tap reveals the confirm and does NOT retire.
        composeRule.onNodeWithContentDescription("Retire clinic").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Confirm retire").assertIsDisplayed()
        assertFalse(retired)

        // Cancel aborts.
        composeRule.onNodeWithText("Cancel").performClick()
        composeRule.waitForIdle()
        assertFalse(retired)

        // Retire then Confirm fires onRetire exactly once.
        composeRule.onNodeWithContentDescription("Retire clinic").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Confirm retire").performClick()
        composeRule.waitForIdle()
        assertTrue(retired)
    }

    /** No control on this card promises removal, because none of them remove. */
    @Test
    fun `offers no delete affordance at all`() {
        composeRule.setContent {
            AuntieOSTheme {
                VetClinicRow(clinic = clinic, usage = VetClinicUsage(), onSave = {}, onRetire = {})
            }
        }
        composeRule.onNodeWithContentDescription("Delete clinic").assertDoesNotExist()
    }

    /**
     * Null usage is "we have not been able to check", not "nobody uses this".
     * The control beside the badge retires the clinic, so the two must not read
     * alike.
     */
    @Test
    fun `an unknown household count reads as checking, never as zero`() {
        composeRule.setContent {
            AuntieOSTheme {
                VetClinicRow(clinic = clinic, usage = null, onSave = {}, onRetire = {})
            }
        }
        composeRule.onNodeWithText("Households: checking", ignoreCase = true).assertIsDisplayed()
        composeRule.onNodeWithText("No households", ignoreCase = true).assertDoesNotExist()
    }

    /** Linked and name-only households are named apart, never summed. */
    @Test
    fun `a name-only household is reported separately from a linked one`() {
        composeRule.setContent {
            AuntieOSTheme {
                VetClinicRow(
                    clinic = clinic,
                    usage = VetClinicUsage(linked = 2, unlinked = 3),
                    onSave = {},
                    onRetire = {},
                )
            }
        }
        composeRule.onNodeWithText("2 linked", ignoreCase = true).assertIsDisplayed()
        composeRule.onNodeWithText("3 by name only", ignoreCase = true).assertIsDisplayed()
    }

    /** A retired row offers Restore, with no confirm step: it is reversible. */
    @Test
    fun `a retired clinic offers restore`() {
        var restored = false
        composeRule.setContent {
            AuntieOSTheme {
                VetClinicRow(
                    clinic = clinic,
                    usage = VetClinicUsage(),
                    onSave = {},
                    onRetire = {},
                    retired = true,
                    onRestore = { restored = true },
                )
            }
        }
        composeRule.onNodeWithText("Restore").performClick()
        composeRule.waitForIdle()
        assertTrue(restored)
    }
}
