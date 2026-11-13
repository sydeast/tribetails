package com.tribetails.auntieos.web.screens.auth

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.test.hasProgressBarRangeInfo
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.PasswordResetResult
import com.tribetails.auntieos.web.data.SignInResult
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.coroutines.CompletableDeferred
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1846: Enter and the keyboard's Done key reach `submit()` even while the button
 * is disabled, so a second press while a sign-in or a password reset is running
 * must not start another request. Drives the real SignInScreen with a fake
 * platform sign-in that stays pending until the test lets it finish.
 */
@OptIn(ExperimentalTestApi::class)
class SignInSubmitGuardTest {

    @Test
    fun aSecondDoneWhileSigningInMakesNoSecondRequest() = runDesktopComposeUiTest {
        var signIns = 0
        val gate = CompletableDeferred<SignInResult>()
        val auth = AuthClient(failedLoginReporter = {}, signInImpl = { _, _ -> signIns++; gate.await() })
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { SignInScreen(auth = auth, onSignedIn = {}) } }

        onAllNodes(hasSetTextAction())[0].performTextInput("e2e-admin@tribetails.com")
        onAllNodes(hasSetTextAction())[1].performTextInput("right-password")
        onAllNodes(hasSetTextAction())[1].performImeAction()
        waitForIdle()
        assertEquals(1, signIns, "the first Done starts a sign-in")
        // The button swaps its label for a spinner while signing in.
        onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate)).assertExists()

        onAllNodes(hasSetTextAction())[1].performImeAction()
        onAllNodes(hasSetTextAction())[1].performImeAction()
        waitForIdle()
        assertEquals(1, signIns, "a repeat Done while it runs is ignored")

        gate.complete(SignInResult.Failure("auth/wrong-password"))
        waitForIdle()
    }

    @Test
    fun doneWhileAPasswordResetIsRunningMakesNoSignInRequest() = runDesktopComposeUiTest {
        var signIns = 0
        var resets = 0
        val resetGate = CompletableDeferred<PasswordResetResult>()
        val auth = AuthClient(
            failedLoginReporter = {},
            signInImpl = { _, _ -> signIns++; SignInResult.Failure("auth/wrong-password") },
            passwordResetImpl = { resets++; resetGate.await() },
        )
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { SignInScreen(auth = auth, onSignedIn = {}) } }

        onAllNodes(hasSetTextAction())[0].performTextInput("e2e-admin@tribetails.com")
        onAllNodes(hasSetTextAction())[1].performTextInput("right-password")
        onNode(hasText("Forgot password?")).performClick()
        waitForIdle()
        assertEquals(1, resets)
        onNode(hasText("Sending…")).assertExists()

        onAllNodes(hasSetTextAction())[1].performImeAction()
        waitForIdle()
        assertEquals(0, signIns, "Done during a reset starts no sign-in")

        resetGate.complete(PasswordResetResult.Sent)
        waitForIdle()
        onAllNodes(hasSetTextAction())[1].performImeAction()
        waitForIdle()
        assertEquals(1, signIns, "once the reset is done, Done signs in again")
    }

    @Test
    fun emptyFieldsOnDoneMakeNoRequest() = runDesktopComposeUiTest {
        var signIns = 0
        val auth = AuthClient(failedLoginReporter = {}, signInImpl = { _, _ -> signIns++; SignInResult.Failure("auth/wrong-password") })
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { SignInScreen(auth = auth, onSignedIn = {}) } }
        onAllNodes(hasSetTextAction())[1].performImeAction()
        waitForIdle()
        assertEquals(0, signIns)
        onNode(hasText("Enter your email.")).assertExists()
    }

    @Test
    fun oneHardwareEnterInPasswordMakesOneRequest() = runDesktopComposeUiTest {
        // A real Enter press reaches submit() twice: the field's Done action on key
        // down and the screen's own Enter handler on key up. Only one may sign in.
        var signIns = 0
        val gate = CompletableDeferred<SignInResult>()
        val auth = AuthClient(failedLoginReporter = {}, signInImpl = { _, _ -> signIns++; gate.await() })
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { SignInScreen(auth = auth, onSignedIn = {}) } }
        onAllNodes(hasSetTextAction())[0].performTextInput("e2e-admin@tribetails.com")
        onAllNodes(hasSetTextAction())[1].performTextInput("right-password")
        onAllNodes(hasSetTextAction())[1].requestFocus()
        onAllNodes(hasSetTextAction())[1].performKeyInput { pressKey(Key.Enter) }
        waitForIdle()
        assertEquals(1, signIns, "one Enter press is one sign-in")
        // The button swaps its label for a spinner while signing in.
        onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate)).assertExists()
        gate.complete(SignInResult.Failure("auth/wrong-password"))
        waitForIdle()
    }

    @Test
    fun forgotPasswordWhileSigningInSendsNoReset() = runDesktopComposeUiTest {
        var resets = 0
        val gate = CompletableDeferred<SignInResult>()
        val auth = AuthClient(
            failedLoginReporter = {},
            signInImpl = { _, _ -> gate.await() },
            passwordResetImpl = { resets++; PasswordResetResult.Sent },
        )
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { SignInScreen(auth = auth, onSignedIn = {}) } }
        onAllNodes(hasSetTextAction())[0].performTextInput("e2e-admin@tribetails.com")
        onAllNodes(hasSetTextAction())[1].performTextInput("right-password")
        onAllNodes(hasSetTextAction())[1].performImeAction()
        waitForIdle()
        onNode(hasText("Forgot password?")).assertIsNotEnabled()
        onNode(hasText("Forgot password?")).performClick()
        waitForIdle()
        assertEquals(0, resets, "no reset while a sign-in is running")
        gate.complete(SignInResult.Failure("auth/wrong-password"))
        waitForIdle()
    }
}
