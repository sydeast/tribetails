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
import com.tribetails.auntieos.data.model.EMERGENCY_CONTACTS_OVER_LIMIT
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

    // Operator ruling 2026-09-27 (Q2): one Emergency Contact per household.
    @Test
    fun oneContactOffersNoAddRemoveOrNotice() {
        val drafts = mutableStateListOf(EmergencyContactDraft("Rae", "8055550199"))
        composeRule.setContent {
            AuntieOSTheme {
                EmergencyContactsEditor(drafts = drafts, onChange = { i, d -> drafts[i] = d }, onRemove = { drafts.removeAt(it) })
            }
        }
        composeRule.onAllNodesWithText("Remove", useUnmergedTree = true).assertCountEquals(0)
        composeRule.onAllNodesWithText("Add a second Emergency Contact", useUnmergedTree = true).assertCountEquals(0)
        composeRule.onNodeWithText(EMERGENCY_CONTACTS_OVER_LIMIT).assertDoesNotExist()
        composeRule.onNodeWithText("Called first").assertDoesNotExist()
    }
    @Test
    fun twoOnFileShowBothUnderTheNoticeWithRemoveAndNoCallFirst() {
        val drafts = mutableStateListOf(EmergencyContactDraft("Rae", "8055550199"), EmergencyContactDraft("Lee", "8055550177"))
        composeRule.setContent {
            AuntieOSTheme {
                EmergencyContactsEditor(drafts = drafts, onChange = { i, d -> drafts[i] = d }, onRemove = { drafts.removeAt(it) })
            }
        }
        composeRule.onNodeWithText(EMERGENCY_CONTACTS_OVER_LIMIT).assertExists()
        composeRule.onAllNodesWithText("Remove", useUnmergedTree = true).assertCountEquals(2)
        composeRule.onAllNodesWithText("Call first", useUnmergedTree = true).assertCountEquals(0)
        composeRule.onAllNodesWithText("Remove", useUnmergedTree = true)[0].performClick()
        assertEquals(listOf(EmergencyContactDraft("Lee", "8055550177")), drafts.toList())
        composeRule.onNodeWithText(EMERGENCY_CONTACTS_OVER_LIMIT).assertDoesNotExist()
        composeRule.onAllNodesWithText("Remove", useUnmergedTree = true).assertCountEquals(0)
    }
    @Test
    fun capsEachInputAtTheServerLimit() {
        val drafts = mutableStateListOf(EmergencyContactDraft())
        composeRule.setContent {
            AuntieOSTheme {
                EmergencyContactsEditor(drafts = drafts, onChange = { i, d -> drafts[i] = d }, onRemove = {})
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
                    onRemove = {},
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
                    onRemove = {},
                )
            }
        }
        composeRule.onNodeWithText("No Emergency Contact").assertDoesNotExist()
        composeRule.onNodeWithText("Unsaved changes").assertDoesNotExist()
    }
}
