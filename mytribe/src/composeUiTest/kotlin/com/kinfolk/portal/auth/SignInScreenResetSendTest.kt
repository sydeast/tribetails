@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.auth

import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test

/**
 * #911: what the sign-in screen says after "Forgot password?", now that the
 * reset goes out through Firebase rather than the `requestPasswordReset`
 * callable.
 *
 * The callable answered `{ ok: true }` for every address, so the screen could
 * not tell a household apart from a stranger typing addresses. Firebase's reset
 * refuses an address it has never seen (unless the project has email
 * enumeration protection on), and a screen that showed that refusal would be an
 * account oracle anyone could query. So an unknown address has to read exactly
 * like a real one, and a genuine failure has to keep reading like a failure.
 */
private class ResetBackend(private val onSend: (String) -> Unit) : AuthBackend by FakeAuthBackend() {
    override suspend fun sendPasswordReset(email: String, continueUrl: String?) = onSend(email)
}

class SignInScreenResetSendTest {

    private fun runForgotPassword(backend: AuthBackend, body: androidx.compose.ui.test.ComposeUiTest.() -> Unit) =
        runComposeUiTest {
            setThemedContent { SignInScreen(repo = AuthRepository(backend), onSignedIn = {}) }
            waitForIdle()
            onAllNodes(hasSetTextAction())[0].performTextInput("ghost@household.test")
            onNodeWithText("Forgot password?").performClick()
            waitForIdle()
            body()
        }

    @Test
    fun anAddressThatIsNotAnAccountReadsExactlyLikeOneThatIs() =
        runForgotPassword(ResetBackend { throw IllegalStateException("auth/user-not-found") }) {
            onNodeWithText("Reset link sent. Check your inbox.").assertExists()
            onNodeWithText("Couldn't send reset email.").assertDoesNotExist()
        }

    @Test
    fun aRealAccountReadsTheSameSentence() =
        runForgotPassword(ResetBackend { }) {
            onNodeWithText("Reset link sent. Check your inbox.").assertExists()
        }

    /** A link that genuinely did not go out is still said out loud. */
    @Test
    fun aSendThatFailedForAnyOtherReasonStillSaysSo() =
        runForgotPassword(ResetBackend { throw IllegalStateException("auth/too-many-requests") }) {
            onNodeWithText("Couldn't send reset email.").assertExists()
            onNodeWithText("Reset link sent. Check your inbox.").assertDoesNotExist()
        }
}
