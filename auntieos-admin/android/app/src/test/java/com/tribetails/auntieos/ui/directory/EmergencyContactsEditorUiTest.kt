package com.tribetails.auntieos.ui.directory

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.tribetails.auntieos.data.model.EMERGENCY_CONTACT_WHO_GETS_CALLED
import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class EmergencyContactsEditorUiTest {

    @get:Rule val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun addsASecondSlotMovesItFirstAndRemovesIt() {
        val drafts = mutableStateListOf(EmergencyContactDraft("Rae", "8055550199"))
        composeRule.setContent {
            AuntieOSTheme {
                EmergencyContactsEditor(
                    drafts = drafts,
                    onChange = { i, d -> drafts[i] = d },
                    onAdd = { drafts.add(EmergencyContactDraft()) },
                    onRemove = { drafts.removeAt(it) },
                    onMoveFirst = { i -> val d = drafts.removeAt(i); drafts.add(0, d) },
                )
            }
        }
        // One contact: nothing to reorder or remove.
        composeRule.onAllNodesWithText("Remove", useUnmergedTree = true).assertCountEquals(0)
        composeRule.onNodeWithText("Add a second Emergency Contact").performClick()
        assertEquals(2, drafts.size)
        composeRule.onNodeWithText("Called second").assertExists()
        // #829 review item 10: Remove on BOTH slots, Call first on the second only.
        composeRule.onAllNodesWithText("Remove", useUnmergedTree = true).assertCountEquals(2)
        composeRule.onAllNodesWithText("Call first", useUnmergedTree = true).assertCountEquals(1)
        composeRule.onNodeWithText("Call first").performClick()
        assertEquals("", drafts[0].name)
        composeRule.onAllNodesWithText("Remove", useUnmergedTree = true)[0].performClick()
        assertEquals(1, drafts.size)
        assertEquals("Rae", drafts[0].name)
    }

    @Test
    fun capsEachInputAtTheServerLimit() {
        val drafts = mutableStateListOf(EmergencyContactDraft())
        composeRule.setContent {
            AuntieOSTheme {
                EmergencyContactsEditor(drafts = drafts, onChange = { i, d -> drafts[i] = d }, onAdd = {}, onRemove = {}, onMoveFirst = {})
            }
        }
        // The first editable field in the slot is Name.
        composeRule.onAllNodes(hasSetTextAction())[0].performTextInput("R".repeat(90))
        assertEquals(80, drafts[0].name.length)
    }

    // #829 review items 10 and 14: the card both Add and Edit show.
    @Test
    fun theSectionHasItsTitleTipFlagUnsavedLineAndError() {
        composeRule.setContent {
            AuntieOSTheme {
                EmergencyContactsSection(
                    drafts = listOf(EmergencyContactDraft()),
                    onChange = { _, _ -> },
                    onAdd = {},
                    onRemove = {},
                    onMoveFirst = {},
                    showNoneOnFile = true,
                    unsaved = true,
                    error = "An Emergency Contact needs a phone number.",
                )
            }
        }
        composeRule.onNodeWithText("Emergency Contacts").assertExists()
        composeRule.onNodeWithContentDescription(EMERGENCY_CONTACT_WHO_GETS_CALLED).assertExists().performClick()
        composeRule.onNodeWithText("No Emergency Contact").assertExists()
        composeRule.onNodeWithText("Unsaved changes").assertExists()
        composeRule.onNodeWithText("An Emergency Contact needs a phone number.").assertExists()
    }

    @Test
    fun theSectionShowsNoFlagOrUnsavedLineWhenThereIsNothingToSay() {
        composeRule.setContent {
            AuntieOSTheme {
                EmergencyContactsSection(
                    drafts = listOf(EmergencyContactDraft("Rae", "8055550199")),
                    onChange = { _, _ -> },
                    onAdd = {},
                    onRemove = {},
                    onMoveFirst = {},
                )
            }
        }
        composeRule.onNodeWithText("No Emergency Contact").assertDoesNotExist()
        composeRule.onNodeWithText("Unsaved changes").assertDoesNotExist()
    }
}
