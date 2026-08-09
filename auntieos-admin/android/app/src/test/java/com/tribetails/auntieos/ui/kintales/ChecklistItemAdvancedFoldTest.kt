package com.tribetails.auntieos.ui.kintales

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.User
import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.FieldCondition
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.ThemeMode
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Item 8, Android half: one checklist row shows its text and its actions, and
 * folds the rest ("Show unchecked response" and the whole conditions builder)
 * behind an "Advanced" disclosure, the way the React editor now does. A six-item
 * template used to render every one of those controls at once.
 *
 * The rule that makes folding safe is the last test here: an item already
 * carrying a condition opens on load, so the fold never hides the only signal
 * that an item is conditional.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1440dp-h2400dp-xhdpi")
class ChecklistItemAdvancedFoldTest {

    @get:Rule
    val compose = createComposeRule()

    private fun render(item: ChecklistItem) {
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                ChecklistItemEditor(
                    item = item,
                    icon = Lucide.User,
                    onUpdate = {},
                    onDelete = {},
                    onPersist = {},
                    onSaveToBank = {},
                    householdTags = emptyList(),
                )
            }
        }
    }

    @Test
    fun plainItem_foldsItsAdvancedControls() {
        render(ChecklistItem(key = "meds", text = "Meds"))

        compose.onNodeWithText("Advanced").assertIsDisplayed()
        compose.onNodeWithText("Show unchecked response").assertDoesNotExist()
        compose.onNodeWithText("CONDITIONS").assertDoesNotExist()
    }

    @Test
    fun tappingAdvanced_revealsTheControls() {
        render(ChecklistItem(key = "meds", text = "Meds"))

        compose.onNodeWithText("Advanced").performClick()

        compose.onNodeWithText("Show unchecked response").assertIsDisplayed()
        compose.onNodeWithText("CONDITIONS").assertIsDisplayed()
    }

    @Test
    fun conditionalItem_opensOnLoad() {
        render(
            ChecklistItem(
                key = "meds",
                text = "Medications given",
                conditions = listOf(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "dog")),
            ),
        )

        compose.onNodeWithText("CONDITIONS").assertIsDisplayed()
    }
}
