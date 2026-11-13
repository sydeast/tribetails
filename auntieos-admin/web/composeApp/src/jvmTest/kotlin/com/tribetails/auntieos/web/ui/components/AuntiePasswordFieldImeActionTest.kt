package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1846: the sign-in password field's keyboard action key (Done) did nothing on
 * the desktop console because the field took no keyboard actions. The sign-in
 * screen now passes `onDone = { submit() }`; this pins that the field forwards
 * the action, and that a field given none stays quiet.
 */
@OptIn(ExperimentalTestApi::class)
class AuntiePasswordFieldImeActionTest {

    @Test
    fun doneKeyRunsTheKeyboardAction() = runDesktopComposeUiTest {
        var done = 0
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                var pw by mutableStateOf("")
                AuntiePasswordField(
                    value = pw,
                    onValueChange = { pw = it },
                    label = "Password",
                    keyboardActions = KeyboardActions(onDone = { done++ }),
                )
            }
        }
        onNode(hasSetTextAction()).performTextInput("right-password")
        onNode(hasSetTextAction()).performImeAction()
        waitForIdle()
        assertEquals(1, done)
    }

    @Test
    fun withoutAKeyboardActionTheDoneKeyIsQuiet() = runDesktopComposeUiTest {
        var done = 0
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AuntiePasswordField(value = "", onValueChange = {}, label = "Password")
            }
        }
        onNode(hasSetTextAction()).performImeAction()
        waitForIdle()
        assertEquals(0, done)
    }
}
