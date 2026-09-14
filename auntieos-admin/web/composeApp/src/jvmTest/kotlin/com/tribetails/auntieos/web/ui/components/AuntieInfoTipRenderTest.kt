package com.tribetails.auntieos.web.ui.components

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACT_WHO_GETS_CALLED
import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.screens.directory.EmergencyContactsEditor
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #829, operator ruling 2026-09-13: the Emergency Contact explanation sits
 * behind an info tip that answers a TAP, not only hover and long-press. The
 * clock is held because a plain tooltip dismisses itself after about 1.5s, and
 * an auto-advancing clock would close it before the assertion ran.
 */
@OptIn(ExperimentalTestApi::class)
class AuntieInfoTipRenderTest {

    @Test
    fun tappingTheIconShowsTheSentence() = runDesktopComposeUiTest {
        mainClock.autoAdvance = false
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { AuntieInfoTip(EMERGENCY_CONTACT_WHO_GETS_CALLED) } }
        mainClock.advanceTimeBy(16L)
        assertTrue(onAllNodesWithText(EMERGENCY_CONTACT_WHO_GETS_CALLED).fetchSemanticsNodes().isEmpty())
        onNodeWithTag(AUNTIE_INFO_TIP_TAG).performClick()
        mainClock.advanceTimeBy(300L)
        onNodeWithText(EMERGENCY_CONTACT_WHO_GETS_CALLED).assertIsDisplayed()
    }

    /**
     * #829 review item 14: the tip moved beside the section title, which
     * KinfolkEditScreen draws (KinfolkEditSaveRenderTest checks it there), so
     * the editor itself carries none. With two contacts both slots offer Remove
     * and only the second offers Call first.
     */
    @Test
    fun theEditorCarriesNoTipAndOffersRemoveOnBothSlots() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                EmergencyContactsEditor(
                    drafts = listOf(EmergencyContactDraft("Rae", "8055550199"), EmergencyContactDraft("Lee", "8055550177")),
                    onChange = { _, _ -> },
                    onAdd = {},
                    onRemove = {},
                    onMoveFirst = {},
                )
            }
        }
        assertTrue(onAllNodesWithTag(AUNTIE_INFO_TIP_TAG).fetchSemanticsNodes().isEmpty())
        // AuntieFieldLabel renders its text uppercased.
        onNodeWithText("CALLED FIRST").assertIsDisplayed()
        onNodeWithText("CALLED SECOND").assertIsDisplayed()
        assertEquals(2, onAllNodesWithText("Remove").fetchSemanticsNodes().size)
        assertEquals(1, onAllNodesWithText("Call first").fetchSemanticsNodes().size)
        // Two on file: no third slot.
        assertTrue(onAllNodesWithText("Add a second Emergency Contact").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun movingTheSecondContactFirstAndAddingASlotReachTheCaller() = runDesktopComposeUiTest {
        var moved = -1
        var added = 0
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                EmergencyContactsEditor(
                    drafts = listOf(EmergencyContactDraft("Rae", "8055550199"), EmergencyContactDraft("Lee", "8055550177")),
                    onChange = { _, _ -> },
                    onAdd = { added++ },
                    onRemove = {},
                    onMoveFirst = { moved = it },
                )
            }
        }
        onNodeWithText("Call first").performClick()
        assertEquals(1, moved)
        assertEquals(0, added)
    }

    @Test
    fun whileSavingTheControlsAreDisabled() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                EmergencyContactsEditor(
                    drafts = listOf(EmergencyContactDraft("Rae", "8055550199")),
                    onChange = { _, _ -> },
                    onAdd = {},
                    onRemove = {},
                    onMoveFirst = {},
                    enabled = false,
                )
            }
        }
        onNodeWithText("Add a second Emergency Contact").assertIsNotEnabled()
    }
}
