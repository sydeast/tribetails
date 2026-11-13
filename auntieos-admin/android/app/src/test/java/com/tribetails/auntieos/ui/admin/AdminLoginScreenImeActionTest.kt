package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.printToString
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.AuthResult
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.AuthGate
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #1846: the keyboard's action key on the Password field signs in, the same as
 * "Jump back in!", and a second press while the sign-in is running starts no
 * second one. The button is disabled while it runs, but the action key does not
 * go through the button, so the screen's own guard is what holds.
 *
 * A REAL [AuntieRepository] over a mockk `FirebaseAuth`, as in
 * [AdminLoginScreenLockedTest].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp")
class AdminLoginScreenImeActionTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val auth = mockk<FirebaseAuth>(relaxed = true)
    private val functions = mockk<FirebaseFunctions>()
    private val callable = mockk<HttpsCallableReference>()
    private val repository = AuntieRepository(
        n8n = mockk<N8nApi>(),
        authGate = AuthGate { auth },
        functionsOverride = functions,
        authProvider = { auth },
        reportScope = CoroutineScope(Dispatchers.Unconfined),
    )

    init {
        every { functions.getHttpsCallable("recordFailedLogin") } returns callable
        every { callable.call(any()) } returns TaskCompletionSource<HttpsCallableResult>().task
    }

    private fun show() {
        composeRule.setContent {
            AuntieOSTheme { AdminLoginScreen(repository = repository, onLoginSuccess = {}) }
        }
    }

    private fun fields() = composeRule.onAllNodes(hasSetTextAction())

    private fun awaitText(text: String) {
        try {
            composeRule.waitUntil(timeoutMillis = 5_000) {
                composeRule.onAllNodes(hasText(text)).fetchSemanticsNodes().isNotEmpty()
            }
        } catch (e: Throwable) {
            throw AssertionError("'$text' never appeared. Tree:\n" + composeRule.onRoot(useUnmergedTree = true).printToString(), e)
        }
    }

    @Test
    fun the_action_key_on_password_signs_in() {
        every { auth.signInWithEmailAndPassword(any(), any()) } returns Tasks.forException<AuthResult>(
            FirebaseAuthInvalidCredentialsException("ERROR_INVALID_CREDENTIAL", "The supplied auth credential is incorrect."),
        )
        show()

        fields()[0].performTextInput("e2e-admin@tribetails.com")
        fields()[1].performTextInput("wrong-password")
        fields()[1].performImeAction()

        awaitText("The supplied auth credential is incorrect.")
        verify(exactly = 1) { auth.signInWithEmailAndPassword("e2e-admin@tribetails.com", "wrong-password") }
    }

    @Test
    fun a_second_action_key_press_while_signing_in_starts_no_second_sign_in() {
        val pending = TaskCompletionSource<AuthResult>()
        every { auth.signInWithEmailAndPassword(any(), any()) } returns pending.task
        show()

        fields()[0].performTextInput("e2e-admin@tribetails.com")
        fields()[1].performTextInput("wrong-password")
        fields()[1].performImeAction()
        // While it runs the button swaps its label for a spinner.
        composeRule.waitUntil(timeoutMillis = 5_000) {
            composeRule.onAllNodes(hasText("Jump back in!")).fetchSemanticsNodes().isEmpty()
        }
        verify(exactly = 1) { auth.signInWithEmailAndPassword(any(), any()) }
        fields()[1].performImeAction()
        fields()[1].performImeAction()

        // Let the first finish. Without the guard the queued presses would now
        // run their own sign-ins behind the repository's lock.
        pending.setException(
            FirebaseAuthInvalidCredentialsException("ERROR_INVALID_CREDENTIAL", "The supplied auth credential is incorrect."),
        )
        awaitText("The supplied auth credential is incorrect.")
        composeRule.waitForIdle()
        verify(exactly = 1) { auth.signInWithEmailAndPassword(any(), any()) }
    }

    @Test
    fun the_action_key_with_empty_fields_names_them_and_sends_nothing() {
        show()

        fields()[1].performImeAction()

        awaitText("Enter your email.")
        verify(exactly = 0) { auth.signInWithEmailAndPassword(any(), any()) }
    }
}
