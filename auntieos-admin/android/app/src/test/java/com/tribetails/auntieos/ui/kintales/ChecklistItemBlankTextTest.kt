package com.tribetails.auntieos.ui.kintales

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.requestFocus
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.User
import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.ChecklistScope
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #1593: the item editor's half of "an empty checklist item saves".
 *
 * The text field reports "unfocused" once when it first composes. Counting that
 * as the operator leaving the item would flag a new item the instant it was
 * added, which is the telling-off the bullet rules out, so only a field that had
 * focus and lost it counts. And once the message is due it is drawn beside the
 * field, in words.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1440dp-h2400dp-xhdpi")
class ChecklistItemBlankTextTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val blank = ChecklistItem(key = "ck_new", text = "", scope = ChecklistScope.PER_PET.name, order = 0)

    private fun render(showBlankError: Boolean, onLeave: () -> Unit = {}) {
        composeRule.setContent {
            AuntieOSTheme {
                Column {
                    ChecklistItemEditor(
                        item = blank,
                        icon = Lucide.User,
                        onUpdate = {},
                        onDelete = {},
                        onPersist = {},
                        onSaveToBank = {},
                        householdTags = emptyList(),
                        showBlankError = showBlankError,
                        onLeave = onLeave,
                    )
                    // Somewhere else to put focus, the way the operator taps the next field.
                    BasicTextField(value = "", onValueChange = {}, modifier = Modifier.testTag("elsewhere"))
                }
            }
        }
    }

    @Test
    fun `composing a new item is not leaving it`() {
        var leaves = 0
        render(showBlankError = false, onLeave = { leaves++ })
        composeRule.waitForIdle()
        assertEquals(0, leaves)
    }

    @Test
    fun `focus in and back out is leaving it, once`() {
        var leaves = 0
        render(showBlankError = false, onLeave = { leaves++ })
        composeRule.waitForIdle()

        composeRule.onAllNodes(hasSetTextAction())[0].requestFocus()
        composeRule.waitForIdle()
        assertEquals(0, leaves)

        composeRule.onNode(hasTestTag("elsewhere")).requestFocus()
        composeRule.waitForIdle()
        assertEquals(1, leaves)
    }

    @Test
    fun `no message until it is due`() {
        render(showBlankError = false)
        composeRule.onNodeWithText(CHECKLIST_ITEM_BLANK).assertDoesNotExist()
    }

    @Test
    fun `a due message is drawn beside the field`() {
        render(showBlankError = true)
        composeRule.onNodeWithText(CHECKLIST_ITEM_BLANK).assertExists()
    }
}
