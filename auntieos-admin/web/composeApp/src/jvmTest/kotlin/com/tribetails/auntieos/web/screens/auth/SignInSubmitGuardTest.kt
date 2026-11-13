package com.tribetails.auntieos.web.screens.auth

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
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
        val auth = AuthClient(signInImpl = { _, _ -> signIns++; gate.await() })
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { SignInScreen(auth = auth, onSignedIn = {}) } }

        onAllNodes(hasSetTextAction())[0].performTextInput("e2e-admin@tribetails.com")
        onAllNodes(hasSetTextAction())[1].performTextInput("right-password")
        onAllNodes(hasSetTextAction())[1].performImeAction()
        waitForIdle()
        assertEquals(1, signIns, "the first Done starts a sign-in")
        onNode(hasText("Signing in…")).assertExists()

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
        val auth = AuthClient(signInImpl = { _, _ -> signIns++; SignInResult.Failure("auth/wrong-password") })
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { SignInScreen(auth = auth, onSignedIn = {}) } }
        onAllNodes(hasSetTextAction())[1].performImeAction()
        waitForIdle()
        assertEquals(0, signIns)
        onNode(hasText("Enter your email.")).assertExists()
    }
}
