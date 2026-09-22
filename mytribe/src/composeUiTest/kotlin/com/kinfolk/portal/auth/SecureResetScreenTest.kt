@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.auth

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import com.kinfolk.portal.util.SecureResetParams
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #905: what the portal app's email action screen shows, on PR #903's contract.
 *
 * The screen this replaces had one state: a form that posted every link to
 * `confirmSecureReset`. These tests pin the states it grew, and the one that
 * matters most is `aNormalResetFilesNoIncident`.
 */
class SecureResetScreenTest {

    private class ScriptedAuth(
        private val info: ActionCodeInfo? = ActionCodeInfo(EmailAction.OP_PASSWORD_RESET, "pat@household.test"),
        private val readFailure: Throwable? = null,
        private val code: String? = null,
    ) : EmailActionAuth {
        val resets = mutableListOf<Pair<String, String>>()
        val applied = mutableListOf<String>()
        val sent = mutableListOf<String>()

        override suspend fun readActionCode(oobCode: String): ActionCodeInfo {
            readFailure?.let { throw it }
            return info!!
        }

        override suspend fun confirmPasswordReset(oobCode: String, newPassword: String) {
            resets += oobCode to newPassword
        }

        override suspend fun applyActionCode(oobCode: String) {
            applied += oobCode
        }

        override suspend fun sendPasswordReset(email: String) {
            sent += email
        }

        override fun errorCodeOf(t: Throwable): String? = code
    }

    private class RecordingFetcher : SecureResetFetcher {
        val calls = mutableListOf<List<String>>()
        override suspend fun confirmReset(
            oobCode: String,
            newPassword: String,
            email: String,
            userAgent: String,
        ): String {
            calls += listOf(oobCode, newPassword, email, userAgent)
            return "inc_42"
        }
    }

    private fun ComposeUiTest.show(
        auth: EmailActionAuth,
        fetcher: SecureResetFetcher = RecordingFetcher(),
        link: SecureResetParams = SecureResetParams(oobCode = "code1"),
        onSignIn: () -> Unit = {},
        openUrl: (String) -> Unit = {},
    ) {
        setThemedContent {
            SecureResetScreen(link = link, auth = auth, fetcher = fetcher, onSignIn = onSignIn, openUrl = openUrl)
        }
        waitForIdle()
    }

    private fun ComposeUiTest.typeBothPasswords(password: String) {
        onNodeWithTag("new-password-input").performTextInput(password)
        onNodeWithTag("confirm-password-input").performTextInput(password)
    }

    // ── The reset form ──────────────────────────────────────────────────────

    /** The account named on the form is the one the verified code belongs to. */
    @Test
    fun theFormNamesTheAccountTheCodeBelongsTo() = runComposeUiTest {
        show(ScriptedAuth())
        onNodeWithText("Set a new password").assertIsDisplayed()
        onNodeWithText("For pat@household.test").assertIsDisplayed()
    }

    /** The defect #905 names. A routine reset alerted the team; now it does not. */
    @Test
    fun aNormalResetFilesNoIncident() = runComposeUiTest {
        val auth = ScriptedAuth()
        val fetcher = RecordingFetcher()
        show(auth, fetcher)
        typeBothPasswords("hunter2hunter2")
        onNodeWithTag("reset-submit").performClick()
        waitForIdle()
        assertEquals(listOf("code1" to "hunter2hunter2"), auth.resets)
        assertEquals(emptyList(), fetcher.calls)
        onNodeWithText("Your password is updated.").assertIsDisplayed()
    }

    @Test
    fun theIDidNotAskChoiceIsTheOnlyPathToAnIncident() = runComposeUiTest {
        val auth = ScriptedAuth()
        val fetcher = RecordingFetcher()
        show(auth, fetcher)
        onNodeWithTag("intent-toggle").performClick()
        waitForIdle()
        onNodeWithText("Secure your account").assertIsDisplayed()
        typeBothPasswords("hunter2hunter2")
        onNodeWithTag("reset-submit").performClick()
        waitForIdle()
        assertEquals(1, fetcher.calls.size)
        assertEquals(emptyList(), auth.resets)
        onNodeWithText("Your account is secured.").assertIsDisplayed()
    }

    @Test
    fun aShortPasswordIsRefusedOnTheFormAndNeverSent() = runComposeUiTest {
        val auth = ScriptedAuth()
        show(auth)
        typeBothPasswords("short")
        onNodeWithTag("reset-submit").performClick()
        waitForIdle()
        onNodeWithText("Password needs at least 8 characters.").assertIsDisplayed()
        assertEquals(emptyList(), auth.resets)
    }

    // ── Codes that do not work ──────────────────────────────────────────────

    @Test
    fun anExpiredResetLinkSaysSoAndSendsANewOne() = runComposeUiTest {
        val auth = ScriptedAuth(readFailure = RuntimeException("gone"), code = "ERROR_EXPIRED_ACTION_CODE")
        show(auth)
        onNodeWithText("This reset link has expired.").assertIsDisplayed()
        onNodeWithTag("resend-email-input").performTextInput("pat@household.test")
        onNodeWithTag("resend-submit").performClick()
        waitForIdle()
        assertEquals(listOf("pat@household.test"), auth.sent)
        onNodeWithTag("resend-sent").assertIsDisplayed()
    }

    @Test
    fun aUsedResetLinkSaysWhichProblemItIs() = runComposeUiTest {
        show(ScriptedAuth(readFailure = RuntimeException("used"), code = "ERROR_INVALID_ACTION_CODE"))
        onNodeWithText("This reset link has already been used or is not valid.").assertIsDisplayed()
        onNodeWithTag("resend-submit").assertIsDisplayed()
    }

    @Test
    fun sendingWithNoAddressAsksForOne() = runComposeUiTest {
        val auth = ScriptedAuth(readFailure = RuntimeException("gone"), code = "EXPIRED_OOB_CODE")
        show(auth)
        onNodeWithTag("resend-submit").performClick()
        waitForIdle()
        onNodeWithText("Type the email you sign in with.").assertIsDisplayed()
        assertEquals(emptyList(), auth.sent)
    }

    @Test
    fun aConnectionFailureOffersARetryRatherThanANewLink() = runComposeUiTest {
        show(ScriptedAuth(readFailure = RuntimeException("socket closed")))
        onNodeWithText("We couldn't check this link.").assertIsDisplayed()
        onNodeWithTag("retry").assertIsDisplayed()
    }

    @Test
    fun aCodeThatIsNotAResetShowsNoForm() = runComposeUiTest {
        show(ScriptedAuth(ActionCodeInfo(EmailAction.OP_VERIFY_EMAIL, "pat@household.test")))
        onNodeWithText("This link can't be completed here.").assertIsDisplayed()
        onNodeWithTag("reset-submit").assertDoesNotExist()
    }

    @Test
    fun aLinkWithNoCodeSaysItIsIncomplete() = runComposeUiTest {
        show(ScriptedAuth(), link = SecureResetParams(oobCode = ""))
        onNodeWithText("This link is incomplete.").assertIsDisplayed()
        onNodeWithTag("reset-submit").assertDoesNotExist()
    }

    @Test
    fun aModeThisAppDoesNotCompleteSaysSo() = runComposeUiTest {
        show(ScriptedAuth(), link = SecureResetParams(oobCode = "code1", mode = "revertSecondFactorAddition"))
        onNodeWithText("This link can't be completed here.").assertIsDisplayed()
    }

    /** Desktop. No form, no incident, just the page that can finish the link. */
    @Test
    fun aDeviceThatCannotCheckCodesOffersTheBrowser() = runComposeUiTest {
        var opened: String? = null
        show(
            ScriptedAuth(readFailure = EmailActionUnsupportedException()),
            openUrl = { opened = it },
        )
        onNodeWithText("Open this link in a web browser.").assertIsDisplayed()
        onNodeWithTag("reset-submit").assertDoesNotExist()
        onNodeWithTag("open-in-browser").performClick()
        waitForIdle()
        assertEquals("https://kinfolk.tribetails.com/account/action?mode=resetPassword&oobCode=code1", opened)
    }

    // ── Where the reader goes next ──────────────────────────────────────────

    /** A bare link cannot tell a household from staff, so it offers both. */
    @Test
    fun aBareLinkOffersBothSignIns() = runComposeUiTest {
        var signedIn = 0
        show(ScriptedAuth(), onSignIn = { signedIn++ })
        typeBothPasswords("hunter2hunter2")
        onNodeWithTag("reset-submit").performClick()
        waitForIdle()
        onNodeWithText("Household sign-in").assertIsDisplayed()
        onNodeWithText("Staff sign-in").assertIsDisplayed()
        onNodeWithTag("portal-sign-in").performClick()
        assertEquals(1, signedIn)
    }

    /** A staff link goes to the admin site, which is a web address, not a screen here. */
    @Test
    fun aStaffLinkOpensTheAdminSignIn() = runComposeUiTest {
        var opened: String? = null
        show(
            ScriptedAuth(),
            link = SecureResetParams(oobCode = "code1", continueUrl = "https://auntie.tribetails.com/signin"),
            openUrl = { opened = it },
        )
        typeBothPasswords("hunter2hunter2")
        onNodeWithTag("reset-submit").performClick()
        waitForIdle()
        onNodeWithTag("staff-sign-in").performClick()
        waitForIdle()
        assertEquals("https://auntie.tribetails.com/signin", opened)
    }

    @Test
    fun aPortalLinkGoesToTheAppsOwnSignIn() = runComposeUiTest {
        var signedIn = 0
        show(
            ScriptedAuth(),
            link = SecureResetParams(oobCode = "code1", continueUrl = "https://kinfolk.tribetails.com/signin"),
            onSignIn = { signedIn++ },
        )
        typeBothPasswords("hunter2hunter2")
        onNodeWithTag("reset-submit").performClick()
        waitForIdle()
        onNodeWithText("Staff sign-in").assertDoesNotExist()
        onNodeWithTag("portal-sign-in").performClick()
        assertEquals(1, signedIn)
    }

    // ── Verify, change and recover ──────────────────────────────────────────

    @Test
    fun aVerifyLinkConfirmsTheAddressOnATap() = runComposeUiTest {
        val auth = ScriptedAuth(ActionCodeInfo(EmailAction.OP_VERIFY_EMAIL, "pat@household.test"))
        show(auth, link = SecureResetParams(oobCode = "code1", mode = EmailAction.MODE_VERIFY))
        onNodeWithText("Confirm your email address").assertIsDisplayed()
        onNodeWithTag("email-apply").performClick()
        waitForIdle()
        assertEquals(listOf("code1"), auth.applied)
        onNodeWithText("Your email address is confirmed.").assertIsDisplayed()
    }

    @Test
    fun aRecoverLinkRestoresTheAddressAndOffersAReset() = runComposeUiTest {
        val auth = ScriptedAuth(ActionCodeInfo(EmailAction.OP_RECOVER_EMAIL, "old@household.test", "new@evil.test"))
        show(auth, link = SecureResetParams(oobCode = "code1", mode = EmailAction.MODE_RECOVER))
        onNodeWithText("Restore your sign-in email").assertIsDisplayed()
        onNodeWithTag("email-apply").performClick()
        waitForIdle()
        onNodeWithText("Your sign-in email is back to old@household.test.").assertIsDisplayed()
        onNodeWithTag("recovery-reset").performClick()
        waitForIdle()
        assertEquals(listOf("old@household.test"), auth.sent)
        onNodeWithTag("recovery-reset-sent").assertIsDisplayed()
    }

    @Test
    fun anEmailChangeLinkNamesTheNewAddress() = runComposeUiTest {
        val auth = ScriptedAuth(
            ActionCodeInfo(EmailAction.OP_VERIFY_AND_CHANGE_EMAIL, "new@household.test", "old@household.test"),
        )
        show(auth, link = SecureResetParams(oobCode = "code1", mode = EmailAction.MODE_VERIFY_AND_CHANGE))
        onNodeWithText("Confirm your new sign-in email").assertIsDisplayed()
        onNodeWithTag("email-apply").performClick()
        waitForIdle()
        onNodeWithText("Your sign-in email is now new@household.test.").assertIsDisplayed()
    }

    @Test
    fun anExpiredVerifyLinkDoesNotOfferAPasswordResend() = runComposeUiTest {
        show(
            ScriptedAuth(readFailure = RuntimeException("gone"), code = "ERROR_EXPIRED_ACTION_CODE"),
            link = SecureResetParams(oobCode = "code1", mode = EmailAction.MODE_VERIFY),
        )
        onNodeWithText("This link has expired.").assertIsDisplayed()
        onNodeWithTag("resend-submit").assertDoesNotExist()
    }
}
