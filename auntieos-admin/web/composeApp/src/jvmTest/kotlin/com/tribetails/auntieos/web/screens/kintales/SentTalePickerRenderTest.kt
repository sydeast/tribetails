package com.tribetails.auntieos.web.screens.kintales
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
/** #1804: with 2+ sent tales the operator can pick which one to read. */
@OptIn(ExperimentalTestApi::class)
class SentTalePickerRenderTest {
    private val newer = KinCareReport(_id = "b", sessionId = "s1", status = "SENT", sentAt = "2026-11-10T18:00:00Z")
    private val older = KinCareReport(_id = "a", sessionId = "s1", status = "SENT", sentAt = "2026-11-09T10:00:00Z")
    @Test
    fun pickerListsEachSentTaleAndReportsThePick() = runDesktopComposeUiTest {
        val picked = mutableListOf<String>()
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                SentTalePicker(sent = listOf(newer, older), selectedId = "b", onSelect = { picked += it })
            }
        }
        onNodeWithText("This visit has 2 sent KinTales", useUnmergedTree = true).assertExists()
        onNodeWithText(sentTaleLabel(newer, 1), useUnmergedTree = true).assertExists()
        onNodeWithText(sentTaleLabel(older, 2), useUnmergedTree = true).performClick()
        waitForIdle()
        assertEquals(listOf("a"), picked)
    }
}
