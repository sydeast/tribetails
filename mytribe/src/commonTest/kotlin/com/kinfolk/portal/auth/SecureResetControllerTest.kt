package com.kinfolk.portal.auth

import com.kinfolk.portal.util.SecureResetParams
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

/**
 * #905: the portal app's email action screen, on PR #903's contract.
 *
 * The defect this closes is in the second test: the screen it replaces called
 * `confirmSecureReset` for every link that reached it, so a routine reset filed
 * a security incident and alerted the team. A normal reset now goes through the
 * auth SDK and files nothing; the endpoint is reached only from the explicit
 * "I did not ask for this reset" choice.
 */
class SecureResetControllerTest {

    private class FakeAuth(
        private val info: ActionCodeInfo? = ActionCodeInfo(EmailAction.OP_PASSWORD_RESET, "pat@household.test"),
        private val readFailure: Throwable? = null,
        private val applyFailure: Throwable? = null,
        private val resetFailure: Throwable? = null,
        private val sendFailure: Throwable? = null,
        private val codes: Map<Throwable, String> = emptyMap(),
    ) : EmailActionAuth {
        var reads = 0
        val resets = mutableListOf<Pair<String, String>>()
        val applied = mutableListOf<String>()
        val sent = mutableListOf<String>()

        override suspend fun readActionCode(oobCode: String): ActionCodeInfo {
            reads++
            readFailure?.let { throw it }
            return info!!
        }

        override suspend fun confirmPasswordReset(oobCode: String, newPassword: String) {
            resetFailure?.let { throw it }
            resets += oobCode to newPassword
        }

        override suspend fun applyActionCode(oobCode: String) {
            applyFailure?.let { throw it }
            applied += oobCode
        }

        override suspend fun sendPasswordReset(email: String) {
            sendFailure?.let { throw it }
            sent += email
        }

        override fun errorCodeOf(t: Throwable): String? = codes[t]
    }

    private class FakeFetcher(private val failure: Throwable? = null) : SecureResetFetcher {
        val calls = mutableListOf<List<String>>()
        override suspend fun confirmReset(
            oobCode: String,
            newPassword: String,
            email: String,
            userAgent: String,
        ): String {
            calls += listOf(oobCode, newPassword, email, userAgent)
            failure?.let { throw it }
            return "inc_42"
        }
    }

    private fun controller(
        scope: CoroutineScope,
        auth: EmailActionAuth,
        fetcher: SecureResetFetcher = FakeFetcher(),
        link: SecureResetParams = SecureResetParams(oobCode = "code1"),
    ) = SecureResetController(
        link = link,
        auth = auth,
        fetcher = fetcher,
        scope = scope,
        userAgent = { "MyTribe-Test/1" },
    )

    // ── Reading the code ────────────────────────────────────────────────────

    /** The account shown is the code's. The link has no way to name one. */
    @Test
    fun aVerifiedResetCodeNamesItsOwnAccount() = runTest {
        val auth = FakeAuth()
        val c = controller(this, auth)
        c.load()
        assertEquals(ActionPhase.ResetReady("pat@household.test"), c.phase)
        assertEquals(1, auth.reads)
    }

    @Test
    fun aLinkWithNoCodeIsIncompleteAndNeverAsksTheServer() = runTest {
        val auth = FakeAuth()
        val c = controller(this, auth, link = SecureResetParams(oobCode = ""))
        assertEquals(ActionPhase.Incomplete, c.phase)
        c.load()
        assertEquals(0, auth.reads)
    }

    @Test
    fun aModeThisAppDoesNotCompleteSaysSoAndNeverAsksTheServer() = runTest {
        val auth = FakeAuth()
        val c = controller(
            this,
            auth,
            link = SecureResetParams(oobCode = "code1", mode = "revertSecondFactorAddition"),
        )
        assertEquals(ActionPhase.Unsupported, c.phase)
        c.load()
        assertEquals(0, auth.reads)
    }

    /**
     * The mode is a URL param anyone can edit; the operation is what the code
     * really does. Every crossed pair has to refuse.
     */
    @Test
    fun aCodeThatIsNotWhatTheModeClaimsIsRefused() = runTest {
        val pairs = listOf(
            EmailAction.MODE_RESET to EmailAction.OP_VERIFY_EMAIL,
            EmailAction.MODE_RESET to EmailAction.OP_RECOVER_EMAIL,
            EmailAction.MODE_VERIFY to EmailAction.OP_PASSWORD_RESET,
            EmailAction.MODE_VERIFY to EmailAction.OP_RECOVER_EMAIL,
            EmailAction.MODE_VERIFY_AND_CHANGE to EmailAction.OP_VERIFY_EMAIL,
            EmailAction.MODE_RECOVER to EmailAction.OP_VERIFY_AND_CHANGE_EMAIL,
        )
        for ((mode, operation) in pairs) {
            val c = controller(
                this,
                FakeAuth(ActionCodeInfo(operation, "pat@household.test")),
                link = SecureResetParams(oobCode = "code1", mode = mode),
            )
            c.load()
            assertEquals(ActionPhase.Mismatch, c.phase, "$mode carrying $operation")
        }
    }

    @Test
    fun aResetCodeWithNoAddressIsTreatedAsInvalid() = runTest {
        val c = controller(this, FakeAuth(ActionCodeInfo(EmailAction.OP_PASSWORD_RESET, null)))
        c.load()
        assertEquals(ActionPhase.Problem(CodeProblem.Invalid), c.phase)
    }

    @Test
    fun anExpiredCodeSaysExpiredAndAUsedOneSaysUsed() = runTest {
        val expired = RuntimeException("expired")
        val used = RuntimeException("used")
        val a = controller(
            this,
            FakeAuth(readFailure = expired, codes = mapOf(expired to "ERROR_EXPIRED_ACTION_CODE")),
        )
        a.load()
        assertEquals(ActionPhase.Problem(CodeProblem.Expired), a.phase)

        val b = controller(
            this,
            FakeAuth(readFailure = used, codes = mapOf(used to "ERROR_INVALID_ACTION_CODE")),
        )
        b.load()
        assertEquals(ActionPhase.Problem(CodeProblem.Invalid), b.phase)
    }

    /** An error that is not about the code is a connection problem, and retryable. */
    @Test
    fun anUnrecognisedFailureIsUnreachableAndRetryReadsAgain() = runTest {
        val auth = FakeAuth(readFailure = RuntimeException("socket closed"))
        val c = controller(this, auth)
        c.load()
        assertEquals(ActionPhase.Problem(CodeProblem.Unreachable), c.phase)
        c.retry()
        advanceUntilIdle()
        assertEquals(2, auth.reads)
    }

    /** Desktop's REST backend cannot check a code. Nothing is set, nothing is filed. */
    @Test
    fun aBackendThatCannotCheckCodesSendsTheReaderToABrowser() = runTest {
        val fetcher = FakeFetcher()
        val c = controller(this, FakeAuth(readFailure = EmailActionUnsupportedException()), fetcher)
        c.load()
        assertEquals(ActionPhase.NotOnThisDevice, c.phase)
        assertEquals(
            "https://kinfolk.tribetails.com/account/action?mode=resetPassword&oobCode=code1",
            c.webUrl,
        )
        assertEquals(0, fetcher.calls.size)
    }

    // ── Setting a password ──────────────────────────────────────────────────

    /** The defect #905 names: a routine reset must file no incident. */
    @Test
    fun aNormalResetUsesTheAuthSdkAndFilesNoIncident() = runTest {
        val auth = FakeAuth()
        val fetcher = FakeFetcher()
        val c = controller(this, auth, fetcher)
        c.load()
        c.submit("hunter2hunter2", "hunter2hunter2")
        advanceUntilIdle()
        assertEquals(ActionPhase.ResetDone(secured = false), c.phase)
        assertEquals(listOf("code1" to "hunter2hunter2"), auth.resets)
        assertEquals(emptyList(), fetcher.calls)
    }

    /** Only the explicit choice reaches confirmSecureReset. */
    @Test
    fun onlyTheIDidNotAskChoiceFilesAnIncident() = runTest {
        val auth = FakeAuth()
        val fetcher = FakeFetcher()
        val c = controller(this, auth, fetcher)
        c.load()
        c.toggleIntent()
        assertEquals(ResetIntent.Secure, c.intent)
        c.submit("hunter2hunter2", "hunter2hunter2")
        advanceUntilIdle()
        assertEquals(ActionPhase.ResetDone(secured = true), c.phase)
        assertEquals(
            listOf(listOf("code1", "hunter2hunter2", "pat@household.test", "MyTribe-Test/1")),
            fetcher.calls,
        )
        assertEquals(emptyList(), auth.resets)
    }

    @Test
    fun goingBackFromTheSecureChoiceRestoresTheNormalReset() = runTest {
        val auth = FakeAuth()
        val fetcher = FakeFetcher()
        val c = controller(this, auth, fetcher)
        c.load()
        c.toggleIntent()
        c.toggleIntent()
        c.submit("hunter2hunter2", "hunter2hunter2")
        advanceUntilIdle()
        assertEquals(emptyList(), fetcher.calls)
        assertEquals(1, auth.resets.size)
    }

    @Test
    fun aPasswordThatDoesNotPassTheFormIsNeverSent() = runTest {
        val auth = FakeAuth()
        val c = controller(this, auth)
        c.load()
        c.submit("short", "short")
        advanceUntilIdle()
        assertEquals("Password needs at least 8 characters.", c.formError)
        c.submit("hunter2hunter2", "hunter2different")
        advanceUntilIdle()
        assertEquals("Passwords don't match.", c.formError)
        assertEquals(emptyList(), auth.resets)
        assertTrue(c.phase is ActionPhase.ResetReady)
    }

    /** A code that lapsed between the read and the save takes the reader to the resend card. */
    @Test
    fun aCodeThatLapsedDuringTheSaveBecomesAProblem() = runTest {
        val gone = RuntimeException("gone")
        val auth = FakeAuth(resetFailure = gone, codes = mapOf(gone to "ERROR_INVALID_ACTION_CODE"))
        val c = controller(this, auth)
        c.load()
        c.submit("hunter2hunter2", "hunter2hunter2")
        advanceUntilIdle()
        assertEquals(ActionPhase.Problem(CodeProblem.Invalid), c.phase)
    }

    @Test
    fun aWeakPasswordStaysOnTheFormAsAFormProblem() = runTest {
        val weak = RuntimeException("weak")
        val auth = FakeAuth(resetFailure = weak, codes = mapOf(weak to "ERROR_WEAK_PASSWORD"))
        val c = controller(this, auth)
        c.load()
        c.submit("password1234", "password1234")
        advanceUntilIdle()
        assertEquals("That password is too easy to guess. Choose a stronger password.", c.formError)
        assertTrue(c.phase is ActionPhase.ResetReady)
    }

    /** The endpoint's own copy reaches the reader as it is. */
    @Test
    fun aServerRefusalOnTheSecureChoiceShowsTheServersWords() = runTest {
        val fetcher = FakeFetcher(SecureResetException("Too many attempts for this account today. Try again tomorrow."))
        val c = controller(this, FakeAuth(), fetcher)
        c.load()
        c.toggleIntent()
        c.submit("hunter2hunter2", "hunter2hunter2")
        advanceUntilIdle()
        assertEquals("Too many attempts for this account today. Try again tomorrow.", c.serverError)
        assertTrue(c.phase is ActionPhase.ResetReady)
    }

    @Test
    fun anOrdinarySaveFailureOffersAnotherTry() = runTest {
        val auth = FakeAuth(resetFailure = RuntimeException("socket closed"))
        val c = controller(this, auth)
        c.load()
        c.submit("hunter2hunter2", "hunter2hunter2")
        advanceUntilIdle()
        assertEquals("We couldn't update your password. Try again in a moment.", c.serverError)
    }

    // ── Sending a new link ──────────────────────────────────────────────────

    @Test
    fun anExpiredLinkSendsANewOneToTheAddressTyped() = runTest {
        val expired = RuntimeException("expired")
        val auth = FakeAuth(readFailure = expired, codes = mapOf(expired to "EXPIRED_OOB_CODE"))
        val c = controller(this, auth)
        c.load()
        c.sendNewLink("  pat@household.test ")
        advanceUntilIdle()
        assertEquals(listOf("pat@household.test"), auth.sent)
        assertEquals(SendState.Sent, c.resend)
    }

    @Test
    fun sendingWithNoAddressAsksForOne() = runTest {
        val auth = FakeAuth()
        val c = controller(this, auth)
        c.sendNewLink("   ")
        advanceUntilIdle()
        assertEquals(SendState.Missing, c.resend)
        assertEquals(emptyList(), auth.sent)
    }

    @Test
    fun aFailedSendSaysSoAndCanBeCleared() = runTest {
        val c = controller(this, FakeAuth(sendFailure = RuntimeException("no network")))
        c.sendNewLink("pat@household.test")
        advanceUntilIdle()
        assertEquals(SendState.Failed, c.resend)
        c.clearResendState()
        assertEquals(SendState.Idle, c.resend)
    }

    // ── Verify, change and recover ──────────────────────────────────────────

    @Test
    fun aVerifyCodeIsAppliedOnTheConfirmTap() = runTest {
        val auth = FakeAuth(ActionCodeInfo(EmailAction.OP_VERIFY_EMAIL, "pat@household.test"))
        val c = controller(
            this,
            auth,
            link = SecureResetParams(oobCode = "code1", mode = EmailAction.MODE_VERIFY),
        )
        c.load()
        assertEquals(ActionPhase.EmailReady("pat@household.test"), c.phase)
        c.apply()
        advanceUntilIdle()
        assertEquals(listOf("code1"), auth.applied)
        assertEquals(ActionPhase.EmailDone("pat@household.test"), c.phase)
    }

    @Test
    fun aRecoverCodeOffersAResetLinkToTheRestoredAddress() = runTest {
        val auth = FakeAuth(ActionCodeInfo(EmailAction.OP_RECOVER_EMAIL, "old@household.test", "new@evil.test"))
        val c = controller(
            this,
            auth,
            link = SecureResetParams(oobCode = "code1", mode = EmailAction.MODE_RECOVER),
        )
        c.load()
        c.apply()
        advanceUntilIdle()
        c.sendRecoveryReset()
        advanceUntilIdle()
        assertEquals(listOf("old@household.test"), auth.sent)
        assertEquals(SendState.Sent, c.recoveryReset)
    }

    /** The reset offer belongs to recover links only. */
    @Test
    fun aVerifyCodeOffersNoRecoveryReset() = runTest {
        val auth = FakeAuth(ActionCodeInfo(EmailAction.OP_VERIFY_EMAIL, "pat@household.test"))
        val c = controller(
            this,
            auth,
            link = SecureResetParams(oobCode = "code1", mode = EmailAction.MODE_VERIFY),
        )
        c.load()
        c.apply()
        advanceUntilIdle()
        c.sendRecoveryReset()
        advanceUntilIdle()
        assertEquals(emptyList(), auth.sent)
    }

    @Test
    fun anApplyFailureThatIsNotAboutTheCodeOffersAnotherTry() = runTest {
        val auth = FakeAuth(
            ActionCodeInfo(EmailAction.OP_VERIFY_EMAIL, "pat@household.test"),
            applyFailure = RuntimeException("socket closed"),
        )
        val c = controller(
            this,
            auth,
            link = SecureResetParams(oobCode = "code1", mode = EmailAction.MODE_VERIFY),
        )
        c.load()
        c.apply()
        advanceUntilIdle()
        assertEquals("We couldn't finish this. Try again in a moment.", c.serverError)
        assertEquals(emptyList(), auth.applied)
        assertTrue(c.phase is ActionPhase.EmailReady)
    }
}
