package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.printToString
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.ActionCodeSettings
import com.google.firebase.auth.AuthResult
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.repository.ACCOUNT_LOCKED_MSG
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
 * #886: when `beforeSignIn` refuses a locked account, the Android admin sign-in
 * screen shows the locked message, and "Forgot password?" is on screen and
 * sends the reset.
 *
 * A REAL [AuntieRepository] over a mockk `FirebaseAuth`, so the screen shows what
 * the repository actually makes of the refusal, not what a stub says it would.
 */
@RunWith(RobolectricTestRunner::class)
// A phone-sized window. Robolectric's default is 320x470px, which puts "Jump back
// in!" below the fold, where a click lands on nothing.
@Config(sdk = [35], qualifiers = "w411dp-h891dp")
class AdminLoginScreenLockedTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val auth = mockk<FirebaseAuth>(relaxed = true)
    private val functions = mockk<FirebaseFunctions>()
    private val callable = mockk<HttpsCallableReference>()
    private val resetCallable = mockk<HttpsCallableReference>()
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
        // The reset goes through our `requestPasswordReset` callable. Its own
        // reference with a COMPLETED task: the report stub above never settles, and
        // a reset on that task would leave the screen hanging on "Sending...".
        every { functions.getHttpsCallable("requestPasswordReset") } returns resetCallable
        every { resetCallable.call(any()) } returns Tasks.forResult(mockk<HttpsCallableResult>(relaxed = true))
    }

    private fun showAndSubmit() {
        composeRule.setContent {
            AuntieOSTheme { AdminLoginScreen(repository = repository, onLoginSuccess = {}) }
        }
        val fields = composeRule.onAllNodes(hasSetTextAction())
        fields[0].performTextInput("auntie@tribetails.test")
        fields[1].performTextInput("right-password")
        composeRule.onNodeWithText("Jump back in!").performScrollTo().performClick()
    }

    /** Waits for [text] to be on screen, and names the whole tree if it never is. */
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
    fun a_locked_account_shows_the_locked_message_and_a_working_reset_control() {
        every { auth.signInWithEmailAndPassword(any(), any()) } returns Tasks.forException<AuthResult>(
            FirebaseAuthException(
                "ERROR_INTERNAL_ERROR",
                "An internal error has occurred. [ BLOCKING_FUNCTION_ERROR_RESPONSE:((HTTP request to " +
                    "https://example.test/beforeSignIn returned HTTP error 403: {\"error\":{\"message\":" +
                    "\"This account is locked. Use the reset password link or contact support.\"," +
                    "\"status\":\"PERMISSION_DENIED\"}})) ]",
            ),
        )

        showAndSubmit()

        awaitText(ACCOUNT_LOCKED_MSG)
        composeRule.onNodeWithText("Forgot password?").performScrollTo().assertIsDisplayed()
            .assertHasClickAction().performClick()
        awaitText("Reset link sent. Check your inbox.")
        verify(exactly = 1) { resetCallable.call(mapOf("email" to "auntie@tribetails.test")) }
        verify(exactly = 0) { auth.sendPasswordResetEmail(any(), any<ActionCodeSettings>()) }
        // The locked refusal is not a credential failure, so nothing is reported.
        verify(exactly = 0) { functions.getHttpsCallable("recordFailedLogin") }
    }

    @Test
    fun a_wrong_password_shows_the_same_message_as_before_and_is_reported() {
        every { auth.signInWithEmailAndPassword(any(), any()) } returns Tasks.forException<AuthResult>(
            FirebaseAuthInvalidCredentialsException("ERROR_INVALID_CREDENTIAL", "The supplied auth credential is incorrect."),
        )

        showAndSubmit()

        awaitText("The supplied auth credential is incorrect.")
        composeRule.onNodeWithText("Forgot password?").assertHasClickAction()
        verify { callable.call(mapOf("email" to "auntie@tribetails.test")) }
    }
}
