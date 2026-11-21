package com.tribetails.auntieos.web.ui.components

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.validateKinAge
import com.tribetails.auntieos.web.data.validateKinWeight
import com.tribetails.auntieos.web.screens.directory.KINFOLK_EDIT_SAVE_PROBLEM
import com.tribetails.auntieos.web.screens.directory.kinEditSaveProblem
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1851: a refused Save said nothing beside the button. The Kin form read
 * "All changes saved" over a Save that would not press, and the Kinfolk form's
 * reason was a banner at the top of the page, off screen.
 */
@OptIn(ExperimentalTestApi::class)
class AuntieSaveBarProblemTest {

    @Test
    fun aProblemReplacesTheStatusLabelAsWritten() {
        val status = saveBarStatus(dirty = false, problem = "Age is wrong.", dirtyLabel = "Unsaved changes", savedLabel = "All changes saved")
        assertEquals("Age is wrong.", status.text)
        assertTrue(status.isProblem)
    }

    @Test
    fun noProblemKeepsTheUsualLabel() {
        val status = saveBarStatus(dirty = true, problem = null, dirtyLabel = "Unsaved changes", savedLabel = "All changes saved")
        assertEquals("UNSAVED CHANGES", status.text)
        assertFalse(status.isProblem)
    }

    @Test
    fun kinEditNamesEveryRefusal() {
        val both = kinEditSaveProblem(validateKinAge("abc-5"), validateKinWeight("heavy-ish"))!!
        assertTrue(both.contains("Age is a number"), both)
        assertTrue(both.contains("Weight is a number"), both)
        assertNull(kinEditSaveProblem(null, null))
    }

    @Test
    fun theBarShowsTheProblemBesideSave() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AuntieSaveBar(
                    dirty = false,
                    saveEnabled = false,
                    onCancel = {},
                    onSave = {},
                    problem = KINFOLK_EDIT_SAVE_PROBLEM,
                )
            }
        }
        waitForIdle()
        onNodeWithText(KINFOLK_EDIT_SAVE_PROBLEM).assertExists()
        assertEquals(0, onAllNodesWithText("ALL CHANGES SAVED").fetchSemanticsNodes().size)
    }
}

