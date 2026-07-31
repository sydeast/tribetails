package com.tribetails.auntieos.ui.directory

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Pins the bug behind "the breeds dropdown does not appear on ANY kin
 * create/edit, especially Android": the suggestion list is gated on a local
 * `focused` flag that was wired to `AuntieField`'s outer `modifier`, which
 * `AuntieField` applies to its wrapping `Column`, not the actual
 * `BasicTextField` inside it. A `Column` is never itself the focused leaf node,
 * so `FocusState.isFocused` read there is always false -- the list could never
 * open, for ANY catalog, seeded or not. `AuntieField.fieldModifier` exists
 * precisely so a caller's focus-tracking modifier reaches the real input
 * (see AdminLoginScreen for the established pattern); BreedDropdownField was
 * the one place still attaching it to the wrong parameter.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BreedDropdownFieldTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val dogs = listOf("Border Collie", "Boxer", "Poodle")

    private fun mount(catalog: List<String> = dogs, note: String? = null) {
        composeRule.setContent {
            AuntieOSTheme {
                BreedDropdownField(
                    value = "",
                    onValueChange = {},
                    catalog = catalog,
                    note = note,
                )
            }
        }
    }

    @Test
    fun `an unfocused field shows no suggestions, even with a seeded catalog`() {
        mount()
        composeRule.onNodeWithText("Boxer").assertDoesNotExist()
    }

    @Test
    fun `focusing a seeded field opens the bank head instead of staying blank`() {
        mount()
        composeRule.onNodeWithContentDescription("Breed").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Boxer").assertIsDisplayed()
        composeRule.onNodeWithText("Border Collie").assertIsDisplayed()
        composeRule.onNodeWithText("Poodle").assertIsDisplayed()
    }

    @Test
    fun `focusing an empty catalog opens nothing, since there is nothing to browse`() {
        mount(catalog = emptyList())
        composeRule.onNodeWithContentDescription("Breed").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Boxer").assertDoesNotExist()
    }

    @Test
    fun `the disclosure note renders regardless of focus`() {
        mount(catalog = emptyList(), note = "Breed bank is empty (dog_breeds / cat_breeds not seeded), type it in.")
        composeRule.onNodeWithText(
            "Breed bank is empty (dog_breeds / cat_breeds not seeded), type it in.",
        ).assertIsDisplayed()
    }
}
