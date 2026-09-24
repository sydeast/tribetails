@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.auth

import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #905: what the sign-in screen says after "Forgot password?", now that the
 * reset goes out through our `requestPasswordReset` callable rather than
 * Firebase's own reset.
 *
 * The callable answers `{ ok: true }` for a known, unknown, locked or capped
 * address alike, so every address that reaches it reads "Reset link sent" and
 * the screen is no account oracle. What the screen still has to tell apart is
 * the callable's per-IP limit, which says to wait, from every other failure,
 * which keeps "Couldn't send reset email.".
 */
private class ResetBackend(private val onSend: (String) -> Unit) : AuthBackend by FakeAuthBackend() {
    override suspend fun sendPasswordReset(email: String) = onSend(email)
}

class SignInScreenResetSendTest {

    private fun runForgotPassword(backend: AuthBackend, body: androidx.compose.ui.test.ComposeUiTest.() -> Unit) =
        runComposeUiTest {
            setThemedContent { SignInScreen(repo = AuthRepository(backend), onSignedIn = {}) }
            waitForIdle()
            onAllNodes(hasSetTextAction())[0].performTextInput("pat@household.test ")
            onNodeWithText("Forgot password?").performClick()
            waitForIdle()
            body()
        }

    @Test
    fun aSentResetSaysSoAndSendsTheTrimmedAddress() {
        val sent = mutableListOf<String>()
        runForgotPassword(ResetBackend { sent += it }) {
            onNodeWithText("Reset link sent. Check your inbox.").assertExists()
            onNodeWithText("Couldn't send reset email.").assertDoesNotExist()
        }
        assertEquals(listOf("pat@household.test"), sent)
    }

    /** The callable's per-IP limit: trying again at once will not work, so the screen says to wait. */
    @Test
    fun aRateLimitedResetSaysToWait() =
        runForgotPassword(ResetBackend { throw IllegalStateException("Too many requests. Try again later.") }) {
            onNodeWithText(RESET_RATE_LIMITED_MESSAGE).assertExists()
            onNodeWithText("Couldn't send reset email.").assertDoesNotExist()
            onNodeWithText("Reset link sent. Check your inbox.").assertDoesNotExist()
        }

    /** A link that genuinely did not go out is still said out loud. */
    @Test
    fun aSendThatFailedForAnyOtherReasonStillSaysSo() =
        runForgotPassword(ResetBackend { throw IllegalStateException("socket closed") }) {
            onNodeWithText("Couldn't send reset email.").assertExists()
            onNodeWithText(RESET_RATE_LIMITED_MESSAGE).assertDoesNotExist()
            onNodeWithText("Reset link sent. Check your inbox.").assertDoesNotExist()
        }
}
