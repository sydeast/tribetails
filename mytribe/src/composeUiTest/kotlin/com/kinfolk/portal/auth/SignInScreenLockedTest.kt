@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.auth

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #886: when `beforeSignIn` refuses a locked account, the portal sign-in screen
 * shows the locked message instead of the opaque banner, and "Forgot password?"
 * stays on screen and sends the reset.
 */
private class RefusingBackend(
    private val failure: Throwable,
    private val kind: SignInFailureKind? = null,
) : AuthBackend by FakeAuthBackend() {
    val resets = mutableListOf<String>()
    private val defaults = FakeAuthBackend()
    override fun classifySignInFailure(t: Throwable): SignInFailureKind = kind ?: defaults.classifySignInFailure(t)
    override suspend fun signInWithEmailPassword(email: String, password: String): AuthState.SignedIn = throw failure
    override suspend fun sendPasswordReset(email: String, continueUrl: String?) {
        resets += email
    }
}

class SignInScreenLockedTest {

    @AfterTest
    fun tearDown() {
        SessionEndedNotice.clear()
    }

    private fun ComposeUiTest.signInWith(backend: AuthBackend) {
        setThemedContent { SignInScreen(repo = AuthRepository(backend), onSignedIn = {}) }
        waitForIdle()
        val fields = onAllNodes(hasSetTextAction())
        fields[0].performTextInput("pat@household.test")
        fields[1].performTextInput("right-password")
        onNodeWithText("Jump back in!").performClick()
        waitForIdle()
    }

    /** #886 review: a trailing space from a mobile keyboard must not reach the reset send. */
    @Test
    fun forgotPassword_sendsTheTrimmedEmail() = runComposeUiTest {
        val backend = RefusingBackend(RuntimeException("unused"))
        setThemedContent { SignInScreen(repo = AuthRepository(backend), onSignedIn = {}) }
        waitForIdle()
        onAllNodes(hasSetTextAction())[0].performTextInput("  pat@household.test ")
        onNodeWithText("Forgot password?").performClick()
        waitForIdle()
        assertEquals(listOf("pat@household.test"), backend.resets)
        onNodeWithText("Reset link sent. Check your inbox.").assertExists()
    }

    @Test
    fun aLockedAccount_showsTheLockedMessage_andTheResetLinkWorks() = runComposeUiTest {
        val backend = RefusingBackend(
            RuntimeException(
                "BLOCKING_FUNCTION_ERROR_RESPONSE : ((HTTP request to https://example.test/beforeSignIn returned HTTP error 403: " +
                    "{\"error\":{\"message\":\"This account is locked. Use the reset password link or contact support.\"," +
                    "\"status\":\"PERMISSION_DENIED\"}}))",
            ),
        )
        signInWith(backend)

        onNodeWithText(ACCOUNT_LOCKED_MESSAGE).assertExists()
        onNodeWithText("An error occurred. It's been reported to Auntie.").assertDoesNotExist()

        onNodeWithText("Forgot password?").assertExists().assertHasClickAction().performClick()
        waitForIdle()
        assertEquals(listOf("pat@household.test"), backend.resets)
        onNodeWithText("Reset link sent. Check your inbox.").assertExists()
    }

    @Test
    fun aWrongPassword_showsThePortalWebSentence_notTheOpaqueBanner() = runComposeUiTest {
        signInWith(RefusingBackend(RuntimeException("auth/invalid-credential"), SignInFailureKind.Credentials))

        onNodeWithText(WRONG_CREDENTIALS_MESSAGE).assertExists()
        onNodeWithText("An error occurred. It's been reported to Auntie.").assertDoesNotExist()
        assertEquals("That email and password did not match. Check for typos and try again.", WRONG_CREDENTIALS_MESSAGE)
    }

    @Test
    fun anOrdinaryFailure_stillShowsTheSameBannerAsBefore() = runComposeUiTest {
        signInWith(RefusingBackend(RuntimeException("Firebase REST signIn failed: HTTP 400")))

        onNodeWithText("An error occurred. It's been reported to Auntie.").assertExists()
        onNodeWithText(ACCOUNT_LOCKED_MESSAGE).assertDoesNotExist()
    }
}
