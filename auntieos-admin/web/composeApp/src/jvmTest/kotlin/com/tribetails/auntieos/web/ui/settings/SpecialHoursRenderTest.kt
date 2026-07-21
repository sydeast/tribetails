package com.tribetails.auntieos.web.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.screens.settings.SpecialHoursEditorRow
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Slice 9 desktop compose UI test for the Special Hours add row (spec 29 item 15.5).
 * Renders the real [SpecialHoursEditorRow] (real BottomBorderField + GhostButton
 * gated by specialHoursAddEnabled) and asserts the "Add" affordance enables only on
 * a valid YYYY-MM-DD date + non-blank, pipe-free hours, and that the Add callback
 * fires only when enabled. Happy / sad / negative / interaction.
 */
@OptIn(ExperimentalTestApi::class)
class SpecialHoursRenderTest {

    @Composable
    private fun Row(date: String, hours: String, onAdd: () -> Unit = {}) {
        var d by remember { mutableStateOf(date) }
        var h by remember { mutableStateOf(hours) }
        AuntieAppTheme(themeMode = ThemeMode.DARK) {
            SpecialHoursEditorRow(date = d, onDate = { d = it }, hours = h, onHours = { h = it }, onAdd = onAdd)
        }
    }

    @Test
    fun addEnabledOnValidDateAndHours() = runDesktopComposeUiTest {
        setContent { Row("2026-07-03", "08:00-12:00") }
        onNodeWithText("Add").assertIsEnabled()
    }

    @Test
    fun addDisabledOnBadDate() = runDesktopComposeUiTest {
        setContent { Row("7/3/26", "08:00-12:00") }
        onNodeWithText("Add").assertIsNotEnabled()
    }

    @Test
    fun addDisabledOnBlankHours() = runDesktopComposeUiTest {
        setContent { Row("2026-07-03", "") }
        onNodeWithText("Add").assertIsNotEnabled()
    }

    @Test
    fun addDisabledWhenHoursContainPipe() = runDesktopComposeUiTest {
        setContent { Row("2026-07-03", "08:00|12:00") }
        onNodeWithText("Add").assertIsNotEnabled()
    }

    @Test
    fun addClickFiresWhenEnabled() = runDesktopComposeUiTest {
        var added = 0
        setContent { Row("2026-07-03", "08:00-12:00", onAdd = { added++ }) }
        onNodeWithText("Add").performClick()
        assertEquals(1, added)
    }
}
