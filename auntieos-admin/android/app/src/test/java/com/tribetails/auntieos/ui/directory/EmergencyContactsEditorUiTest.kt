package com.tribetails.auntieos.ui.directory

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
        composeRule.onNodeWithText("Add a second Emergency Contact").performClick()
        assertEquals(2, drafts.size)
        composeRule.onNodeWithText("Called second").assertExists()
        composeRule.onNodeWithText("Call first").performClick()
        assertEquals("", drafts[0].name)
        composeRule.onNodeWithText("Remove", useUnmergedTree = true).performClick()
        assertEquals(1, drafts.size)
    }
}
