@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.auth

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.CompletableDeferred

/**
 * #1846 (same defect as the admin web): the keyboard's action key on the sign-in
 * fields did nothing. Email now advances to Password; Password's action key
 * signs in, the same as the button, and an empty form still does not submit.
 */
private class RecordingBackend(
    private val failure: Throwable? = null,
    private val gate: CompletableDeferred<Unit>? = null,
) : AuthBackend by FakeAuthBackend() {
    val attempts = mutableListOf<Pair<String, String>>()
    private val defaults = FakeAuthBackend()
    override fun classifySignInFailure(t: Throwable): SignInFailureKind =
        if (t is IllegalArgumentException) SignInFailureKind.Credentials else defaults.classifySignInFailure(t)
    override suspend fun signInWithEmailPassword(email: String, password: String): AuthState.SignedIn {
        attempts += email to password
        gate?.await()
        failure?.let { throw it }
        return defaults.signInWithEmailPassword(email, password)
    }
}

class SignInScreenKeyboardActionTest {

    @AfterTest
    fun tearDown() {
        SessionEndedNotice.clear()
    }

    private fun ComposeUiTest.open(backend: AuthBackend) {
        setThemedContent { SignInScreen(repo = AuthRepository(backend), onSignedIn = {}) }
        waitForIdle()
    }

    @Test
    fun happy_actionKeyOnPassword_signsInOnce() = runComposeUiTest {
        val backend = RecordingBackend()
        open(backend)
        val fields = onAllNodes(hasSetTextAction())
        fields[0].performTextInput("pawsome@hanasamku.com")
        fields[1].performTextInput("right-password")
        fields[1].performImeAction()
        waitForIdle()
        assertEquals(listOf("pawsome@hanasamku.com" to "right-password"), backend.attempts)
    }

    @Test
    fun happy_actionKeyOnEmail_movesFocusToPassword_withoutSubmitting() = runComposeUiTest {
        val backend = RecordingBackend()
        open(backend)
        val fields = onAllNodes(hasSetTextAction())
        fields[0].performTextInput("pawsome@hanasamku.com")
        fields[0].performImeAction()
        waitForIdle()
        fields[1].assertIsFocused()
        assertEquals(emptyList(), backend.attempts)
    }

    @Test
    fun negative_actionKeyOnEmptyForm_doesNotSubmit_andSaysWhy() = runComposeUiTest {
        val backend = RecordingBackend()
        open(backend)
        val fields = onAllNodes(hasSetTextAction())
        fields[1].performImeAction()
        waitForIdle()
        assertEquals(emptyList(), backend.attempts)
        onNodeWithText("Email and password are required.").assertIsDisplayed()
    }

    @Test
    fun sad_wrongPassword_showsTheError_andKeepsTheEmail() = runComposeUiTest {
        val backend = RecordingBackend(failure = IllegalArgumentException("bad credential"))
        open(backend)
        val fields = onAllNodes(hasSetTextAction())
        fields[0].performTextInput("pawsome@hanasamku.com")
        fields[1].performTextInput("wrong")
        fields[1].performImeAction()
        waitForIdle()
        onNodeWithText(WRONG_CREDENTIALS_MESSAGE).assertIsDisplayed()
        onNodeWithText("pawsome@hanasamku.com").assertIsDisplayed()
        onNodeWithText("Jump back in!").assertIsDisplayed()
    }

    @Test
    fun error_networkFailure_isShown_andTheFormRecovers() = runComposeUiTest {
        val backend = RecordingBackend(failure = RuntimeException("network down"))
        open(backend)
        val fields = onAllNodes(hasSetTextAction())
        fields[0].performTextInput("pawsome@hanasamku.com")
        fields[1].performTextInput("right-password")
        fields[1].performImeAction()
        waitForIdle()
        onNodeWithText("An error occurred. It's been reported to Auntie.").assertIsDisplayed()
        onNodeWithText("Jump back in!").assertIsDisplayed()
    }

    @Test
    fun wait_whileSigningIn_showsTheIndicator_andASecondActionKeyDoesNotResubmit() = runComposeUiTest {
        val gate = CompletableDeferred<Unit>()
        val backend = RecordingBackend(gate = gate)
        open(backend)
        val fields = onAllNodes(hasSetTextAction())
        fields[0].performTextInput("pawsome@hanasamku.com")
        fields[1].performTextInput("right-password")
        fields[1].performImeAction()
        waitForIdle()
        onNodeWithText("Signing in…").assertIsDisplayed()
        fields[1].performImeAction()
        waitForIdle()
        assertEquals(1, backend.attempts.size)
        gate.complete(Unit)
        waitForIdle()
    }
}
