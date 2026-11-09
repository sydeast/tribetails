package com.tribetails.auntieos.web.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.SettingsChecks
import com.tribetails.auntieos.web.screens.settings.SpecialHoursEditorRow
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Slice 9 desktop compose UI test for the Special Hours add row (spec 29 item 15.5).
 * Renders the real [SpecialHoursEditorRow] and asserts the "Add" affordance
 * enables only on a real date that has not passed + HH:MM-HH:MM hours closing
 * after opening, that a refused row says why beside the field (#1593), and that
 * the Add callback fires only when enabled.
 */
@OptIn(ExperimentalTestApi::class)
class SpecialHoursRenderTest {

    private val today = "2026-11-09"

    @Composable
    private fun Row(date: String, hours: String, onAdd: () -> Unit = {}) {
        var d by remember { mutableStateOf(date) }
        var h by remember { mutableStateOf(hours) }
        AuntieAppTheme(themeMode = ThemeMode.DARK) {
            SpecialHoursEditorRow(date = d, onDate = { d = it }, hours = h, onHours = { h = it }, todayIso = today, onAdd = onAdd)
        }
    }

    private fun androidx.compose.ui.test.SemanticsNodeInteractionsProvider.shown(text: String): Boolean =
        onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun addEnabledOnValidDateAndHours() = runDesktopComposeUiTest {
        setContent { Row("2026-12-24", "08:00-12:00") }
        onNodeWithText("Add").assertIsEnabled()
    }

    @Test
    fun addDisabledOnBadDate() = runDesktopComposeUiTest {
        setContent { Row("7/3/26", "08:00-12:00") }
        onNodeWithText("Add").assertIsNotEnabled()
        assertTrue(shown(SettingsChecks.DATE_INVALID), "the date's sentence is on screen")
    }

    @Test
    fun aPastDateSaysSo() = runDesktopComposeUiTest {
        setContent { Row("2026-07-03", "08:00-12:00") }
        onNodeWithText("Add").assertIsNotEnabled()
        assertTrue(shown(SettingsChecks.DATE_PAST))
    }

    @Test
    fun addDisabledOnBlankHours() = runDesktopComposeUiTest {
        setContent { Row("2026-12-24", "") }
        onNodeWithText("Add").assertIsNotEnabled()
        assertTrue(shown(SettingsChecks.HOURS_RANGE_INVALID))
    }

    @Test
    fun addDisabledWhenHoursContainPipe() = runDesktopComposeUiTest {
        setContent { Row("2026-12-24", "08:00|12:00") }
        onNodeWithText("Add").assertIsNotEnabled()
    }

    @Test
    fun closingBeforeOpeningSaysSo() = runDesktopComposeUiTest {
        setContent { Row("2026-12-24", "17:00-09:00") }
        onNodeWithText("Add").assertIsNotEnabled()
        assertTrue(shown(SettingsChecks.HOURS_CLOSE_BEFORE_OPEN))
    }

    @Test
    fun addClickFiresWhenEnabled() = runDesktopComposeUiTest {
        var added = 0
        setContent { Row("2026-12-24", "08:00-12:00", onAdd = { added++ }) }
        onNodeWithText("Add").performClick()
        assertEquals(1, added)
    }
}
