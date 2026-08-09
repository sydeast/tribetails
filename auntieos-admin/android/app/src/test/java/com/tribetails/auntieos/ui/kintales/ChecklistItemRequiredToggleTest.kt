package com.tribetails.auntieos.ui.kintales

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.User
import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.ChecklistScope
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Android checklist editor must expose `ChecklistItem.required`, the flag the
 * React admin (KinTaleTemplates.tsx, a role="switch" named "Required") and the web
 * Compose editor both write. Without a control here the flag is invisible on the
 * phone even though every Android save carries it.
 *
 * The toggle carries the accessible name "Required" so it matches React's switch
 * semantics, and is the handle these tests grab it by. AuntieToggle publishes only
 * Role.Switch — no ToggleableState — so checked-ness is not assertable from
 * semantics; the contract under test is the callback pair instead: the edit reaches
 * onUpdate, and it is persisted, in BOTH directions.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1440dp-h2400dp-xhdpi")
class ChecklistItemRequiredToggleTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun item(required: Boolean) = ChecklistItem(
        key = "ck_meds",
        text = "Medications given",
        scope = ChecklistScope.PER_PET.name,
        required = required,
        order = 0,
    )

    private fun render(
        item: ChecklistItem,
        onUpdate: (ChecklistItem) -> Unit,
        onPersist: () -> Unit,
    ) {
        composeRule.setContent {
            AuntieOSTheme {
                ChecklistItemEditor(
                    item = item,
                    icon = Lucide.User,
                    onUpdate = onUpdate,
                    onDelete = {},
                    onPersist = onPersist,
                    onSaveToBank = {},
                    householdTags = emptyList(),
                )
            }
        }
    }

    @Test
    fun `turning Required on routes the edit into onUpdate and persists it`() {
        var updated: ChecklistItem? = null
        var persists = 0
        render(item(required = false), onUpdate = { updated = it }, onPersist = { persists++ })
        composeRule.waitForIdle()
        // The item-text field persists on losing focus, and reports unfocused once at
        // composition, so count the persists the CLICK causes, not the total.
        val persistsBeforeClick = persists

        composeRule.onNodeWithContentDescription("Required").performClick()
        composeRule.waitForIdle()

        val edited = updated
        assertNotNull("the Required toggle must route an edit into onUpdate", edited)
        assertEquals(true, edited!!.required)
        assertEquals("Medications given", edited.text)
        assertEquals(
            "toggling Required must persist, like the sibling toggle",
            persistsBeforeClick + 1,
            persists,
        )
    }

    @Test
    fun `turning Required off routes the edit into onUpdate and persists it`() {
        var updated: ChecklistItem? = null
        var persists = 0
        render(item(required = true), onUpdate = { updated = it }, onPersist = { persists++ })
        composeRule.waitForIdle()
        val persistsBeforeClick = persists

        composeRule.onNodeWithContentDescription("Required").performClick()
        composeRule.waitForIdle()

        val edited = updated
        assertNotNull("the Required toggle must route an edit into onUpdate", edited)
        assertEquals(false, edited!!.required)
        assertEquals(persistsBeforeClick + 1, persists)
    }
}
