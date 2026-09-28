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
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACTS_OVER_LIMIT
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
     * the editor itself carries none. Operator ruling 2026-09-27 (Q2): one
     * Emergency Contact per household, so one contact shows no Add, no Remove
     * and no notice.
     */
    @Test
    fun theEditorCarriesNoTipAndOneContactOffersNoAddOrRemove() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                EmergencyContactsEditor(
                    drafts = listOf(EmergencyContactDraft("Rae", "8055550199")),
                    onChange = { _, _ -> },
                    onRemove = {},
                )
            }
        }
        assertTrue(onAllNodesWithTag(AUNTIE_INFO_TIP_TAG).fetchSemanticsNodes().isEmpty())
        assertTrue(onAllNodesWithText("Remove").fetchSemanticsNodes().isEmpty())
        assertTrue(onAllNodesWithText("Add a second Emergency Contact").fetchSemanticsNodes().isEmpty())
        assertTrue(onAllNodesWithText(EMERGENCY_CONTACTS_OVER_LIMIT).fetchSemanticsNodes().isEmpty())
        assertTrue(onAllNodesWithText("CALLED FIRST").fetchSemanticsNodes().isEmpty())
    }
    /** Two on file from the earlier rule: both show under the notice, each with Remove, no Call first. */
    @Test
    fun twoOnFileShowTheNoticeAndRemoveOnEachSlot() = runDesktopComposeUiTest {
        var removed = -1
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                EmergencyContactsEditor(
                    drafts = listOf(EmergencyContactDraft("Rae", "8055550199"), EmergencyContactDraft("Lee", "8055550177")),
                    onChange = { _, _ -> },
                    onRemove = { removed = it },
                )
            }
        }
        onNodeWithText(EMERGENCY_CONTACTS_OVER_LIMIT).assertIsDisplayed()
        assertEquals(2, onAllNodesWithText("Remove").fetchSemanticsNodes().size)
        assertTrue(onAllNodesWithText("Call first").fetchSemanticsNodes().isEmpty())
        onAllNodesWithText("Remove")[1].performClick()
        assertEquals(1, removed)
    }
    @Test
    fun whileSavingTheControlsAreDisabled() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                EmergencyContactsEditor(
                    drafts = listOf(EmergencyContactDraft("Rae", "8055550199"), EmergencyContactDraft("Lee", "8055550177")),
                    onChange = { _, _ -> },
                    onRemove = {},
                    enabled = false,
                )
            }
        }
        onAllNodesWithText("Remove")[0].assertIsNotEnabled()
    }
}
