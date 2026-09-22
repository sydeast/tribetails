package com.kinfolk.portal.auth

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.kinfolk.portal.screens.claim.validateNewPassword
import com.kinfolk.portal.util.SecureResetParams
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Where the email action screen is. One value at a time, so the screen renders exactly one thing. */
sealed interface ActionPhase {
    /** The code is being read. Shown with a spinner. */
    data object Checking : ActionPhase

    /** The link had no `oobCode`. */
    data object Incomplete : ActionPhase

    /** A `mode` this app does not complete (e.g. `revertSecondFactorAddition`). */
    data object Unsupported : ActionPhase

    /** The code's real operation is not what the link's `mode` claims. */
    data object Mismatch : ActionPhase

    /** This device's auth backend cannot check codes (desktop). Nothing is set or filed. */
    data object NotOnThisDevice : ActionPhase

    data class Problem(val problem: CodeProblem) : ActionPhase

    /** A verified reset code, for [email]. */
    data class ResetReady(val email: String) : ActionPhase

    /** A verified verify, change or recover code. */
    data class EmailReady(val email: String?) : ActionPhase

    data class ResetDone(val secured: Boolean) : ActionPhase

    data class EmailDone(val email: String?) : ActionPhase
}

/** Whether the reset form is a normal reset or the "I did not ask for this reset" path. */
enum class ResetIntent { Reset, Secure }

enum class SendState { Idle, Sending, Sent, Failed, Missing }

/**
 * State holder for [SecureResetScreen], the portal Android app's email action
 * handler (#905). It follows the web page's contract (`mytribe/web/src/screens/SecureReset.tsx`,
 * PR #903) step for step:
 *
 * - The code is read first ([EmailActionAuth.readActionCode]) and its operation
 *   must match the link's `mode`, or the screen says "This link can't be completed here."
 * - The account shown is the one the code belongs to. The URL never names it.
 * - A normal reset sets the password with [EmailActionAuth.confirmPasswordReset]
 *   and files NO incident.
 * - Only [ResetIntent.Secure], the explicit "I did not ask for this reset"
 *   choice, calls `confirmSecureReset` through [SecureResetFetcher].
 * - Expired and used-or-invalid codes each get their own message, and a reset
 *   link offers "Send a new link". A network failure offers a retry.
 */
class SecureResetController(
    private val link: SecureResetParams,
    private val auth: EmailActionAuth,
    private val fetcher: SecureResetFetcher,
    private val scope: CoroutineScope,
    private val userAgent: () -> String = { platformUserAgent() },
) {
    val mode: String get() = link.mode
    val continueUrl: String? get() = link.continueUrl
    val isRecover: Boolean get() = link.mode == EmailAction.MODE_RECOVER
    val isChange: Boolean get() = link.mode == EmailAction.MODE_VERIFY_AND_CHANGE

    var phase by mutableStateOf(initialPhase())
        private set

    var intent by mutableStateOf(ResetIntent.Reset)
        private set

    /** A save or apply is in flight. Fields and buttons disable, and the button shows a spinner. */
    var busy by mutableStateOf(false)
        private set

    /** A problem with what was typed. */
    var formError by mutableStateOf<String?>(null)
        private set

    /** A problem with the save itself. */
    var serverError by mutableStateOf<String?>(null)
        private set

    /** "Send a new link" on an expired or used reset link. */
    var resend by mutableStateOf(SendState.Idle)
        private set

    /** "Send me a password reset link" after an email change is rolled back. */
    var recoveryReset by mutableStateOf(SendState.Idle)
        private set

    private fun initialPhase(): ActionPhase = when {
        link.oobCode.isBlank() -> ActionPhase.Incomplete
        link.mode !in EmailAction.HANDLED_MODES -> ActionPhase.Unsupported
        else -> ActionPhase.Checking
    }

    /** Reads the code. Call once on entry; [retry] calls it again after a network failure. */
    suspend fun load() {
        if (link.oobCode.isBlank() || link.mode !in EmailAction.HANDLED_MODES) return
        phase = ActionPhase.Checking
        phase = try {
            val info = auth.readActionCode(link.oobCode)
            when {
                info.operation != EmailAction.OPERATION_FOR_MODE[link.mode] -> ActionPhase.Mismatch
                link.mode == EmailAction.MODE_RESET ->
                    info.email?.takeIf { it.isNotBlank() }?.let { ActionPhase.ResetReady(it) }
                        ?: ActionPhase.Problem(CodeProblem.Invalid)
                else -> ActionPhase.EmailReady(info.email)
            }
        } catch (c: CancellationException) {
            throw c
        } catch (_: EmailActionUnsupportedException) {
            ActionPhase.NotOnThisDevice
        } catch (t: Throwable) {
            ActionPhase.Problem(problemOf(t) ?: CodeProblem.Unreachable)
        }
    }

    fun retry() {
        scope.launch { load() }
    }

    /** Switches between the normal reset and "I did not ask for this reset". */
    fun toggleIntent() {
        if (busy) return
        intent = if (intent == ResetIntent.Reset) ResetIntent.Secure else ResetIntent.Reset
        serverError = null
    }

    fun clearFormError() {
        formError = null
    }

    fun submit(newPassword: String, confirmPassword: String) {
        val ready = phase as? ActionPhase.ResetReady ?: return
        if (busy) return
        val problem = validateNewPassword(newPassword, confirmPassword)
        if (problem != null) {
            formError = problem
            return
        }
        formError = null
        serverError = null
        busy = true
        val secure = intent == ResetIntent.Secure
        scope.launch {
            try {
                if (secure) {
                    fetcher.confirmReset(
                        oobCode = link.oobCode,
                        newPassword = newPassword,
                        email = ready.email,
                        userAgent = userAgent(),
                    )
                    phase = ActionPhase.ResetDone(secured = true)
                } else {
                    auth.confirmPasswordReset(link.oobCode, newPassword)
                    phase = ActionPhase.ResetDone(secured = false)
                }
            } catch (c: CancellationException) {
                throw c
            } catch (e: SecureResetException) {
                serverError = e.message
            } catch (t: Throwable) {
                val codeProblem = problemOf(t)
                when {
                    codeProblem != null -> phase = ActionPhase.Problem(codeProblem)
                    isWeakPasswordCode(auth.errorCodeOf(t)) ->
                        formError = "That password is too easy to guess. Choose a stronger password."
                    secure -> serverError = "We couldn't secure your account. Check your connection and try again."
                    else -> serverError = "We couldn't update your password. Try again in a moment."
                }
            } finally {
                busy = false
            }
        }
    }

    /** Confirms, changes or restores the email for a verified verify, change or recover code. */
    fun apply() {
        val ready = phase as? ActionPhase.EmailReady ?: return
        if (busy) return
        busy = true
        serverError = null
        scope.launch {
            try {
                auth.applyActionCode(link.oobCode)
                phase = ActionPhase.EmailDone(ready.email)
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                val codeProblem = problemOf(t)
                if (codeProblem != null) {
                    phase = ActionPhase.Problem(codeProblem)
                } else {
                    serverError = "We couldn't finish this. Try again in a moment."
                }
            } finally {
                busy = false
            }
        }
    }

    /** "Send a new link" from an expired or used reset link. */
    fun sendNewLink(email: String) {
        if (resend == SendState.Sending) return
        val address = email.trim()
        if (address.isEmpty()) {
            resend = SendState.Missing
            return
        }
        resend = SendState.Sending
        scope.launch {
            resend = try {
                auth.sendPasswordReset(address)
                SendState.Sent
            } catch (c: CancellationException) {
                throw c
            } catch (_: Throwable) {
                SendState.Failed
            }
        }
    }

    fun clearResendState() {
        if (resend != SendState.Sending) resend = SendState.Idle
    }

    /** After a recover link restores the old address, sends a reset link to it. */
    fun sendRecoveryReset() {
        val done = phase as? ActionPhase.EmailDone ?: return
        val email = done.email ?: return
        if (!isRecover || recoveryReset == SendState.Sending) return
        recoveryReset = SendState.Sending
        scope.launch {
            recoveryReset = try {
                auth.sendPasswordReset(email)
                SendState.Sent
            } catch (c: CancellationException) {
                throw c
            } catch (_: Throwable) {
                SendState.Failed
            }
        }
    }

    private fun problemOf(t: Throwable): CodeProblem? = codeProblemOf(auth.errorCodeOf(t))
}
