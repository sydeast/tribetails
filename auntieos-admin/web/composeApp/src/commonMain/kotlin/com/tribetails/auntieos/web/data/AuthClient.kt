package com.tribetails.auntieos.web.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/**
 * Firebase Auth facade. wasmJs implementation talks to `window.__fb.{signIn,signOut,onAuthChange}`
 * (defined in `wasmJsMain/resources/index.html`). Future Android target will swap to GitLive
 * Firebase Auth or the official Android SDK.
 */
/**
 * #886: the ONE scope every [AuthClient] launches its failed-login reports in.
 *
 * `AuthClient()` is constructed in App.kt, N8nClient and three screens, often
 * inside `remember`, so a scope per instance meant a fresh `SupervisorJob` for
 * every one of them that nothing ever cancelled. The console is a single process
 * and a report is one short callable that must outlive the screen that fired it,
 * so a single process-lifetime scope is the app lifecycle here.
 */
internal val sharedAuthReportScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

class AuthClient(
    /** Test seam: the platform sign-in. Production passes nothing. */
    private val signInImpl: suspend (String, String) -> SignInResult = { e, p -> platformSignIn(e, p) },
    /** #886 test seam: where a credential failure is reported. Production posts to `recordFailedLogin`. */
    private val failedLoginReporter: suspend (String) -> Unit = { platformReportFailedLogin(it) },
    /** #886: where that report runs. Production shares [sharedAuthReportScope]; tests pass `Unconfined`. */
    private val reportScope: CoroutineScope = sharedAuthReportScope,
) {
    /** Test seam: which scope reports run in. */
    internal val reportScopeForTest: CoroutineScope get() = reportScope

    /** Hot stream of the current auth state. Emits null when signed out. */
    fun authStateStream(): Flow<AuthUser?> = platformAuthStateStream()

    /**
     * @return SignInResult.Ok with user, or SignInResult.Failure with code/message.
     *
     * #886: a credential failure is reported to `recordFailedLogin` in the
     * background (fire and forget) and the same Failure is returned at once.
     */
    suspend fun signIn(email: String, password: String): SignInResult {
        val result = signInImpl(email, password)
        if (result is SignInResult.Failure && shouldReportFailedLogin(result.code)) {
            reportInBackground(email.trim())
        }
        return result
    }

    /** Swallows and logs its own failures. */
    private fun reportInBackground(email: String) {
        try {
            reportScope.launch {
                try {
                    failedLoginReporter(email)
                } catch (c: CancellationException) {
                    throw c
                } catch (t: Throwable) {
                    println("[AuntieOS][auth] recordFailedLogin report failed: ${t.message}")
                }
            }
        } catch (t: Throwable) {
            println("[AuntieOS][auth] recordFailedLogin report could not start: ${t.message}")
        }
    }

    suspend fun signOut() = platformSignOut()

    suspend fun sendPasswordReset(email: String): Boolean = platformSendPasswordReset(email)

    suspend fun idToken(forceRefresh: Boolean = false): String? = platformIdToken(forceRefresh)

    suspend fun isCurrentUserAdmin(forceRefresh: Boolean = true): Boolean =
        platformIsCurrentUserAdmin(forceRefresh)

    /**
     * Stage 0I: read the `testTribeId` custom claim off the current ID token and
     * resolve it into a [TestMode]. A signed-in normal admin (no claim) returns
     * [TestMode.OFF]; a signed-in test admin returns an active TestMode scoped to
     * its kinfolk id. Force-refreshes by default so a freshly-set claim is seen
     * without a full re-login.
     */
    suspend fun currentTestMode(forceRefresh: Boolean = true): TestMode =
        TestMode.fromClaim(platformTestTribeId(forceRefresh))

    /**
     * Reauthenticate with [currentPassword], then send a verify-before-update link
     * to [newEmail]. The login email only changes AFTER the operator confirms via
     * that link, so we never report a fake "changed" state. Ok = link sent.
     */
    suspend fun updateLoginEmail(currentPassword: String, newEmail: String): AuthOpResult =
        platformUpdateEmail(currentPassword, newEmail)

    /** Reauthenticate with [currentPassword], then set [newPassword]. */
    suspend fun updatePassword(currentPassword: String, newPassword: String): AuthOpResult =
        platformUpdatePassword(currentPassword, newPassword)
}

/** Result of a credential-mutating auth op (email/password change). */
sealed class AuthOpResult {
    object Ok : AuthOpResult()
    data class Failure(val code: String) : AuthOpResult() {
        val friendly: String get() = friendlyAuthError(code)
    }
}

/** Maps a Firebase Auth error code to operator-facing copy. Pure; unit-tested. */
fun friendlyAuthError(code: String): String = when (code) {
    "auth/requires-recent-login"  -> "Please sign in again, then retry this change."
    "auth/wrong-password",
    "auth/invalid-credential"     -> "Current password is incorrect."
    "auth/email-already-in-use"   -> "That email is already in use."
    "auth/invalid-email"          -> "That email doesn't look right."
    "auth/weak-password"          -> "Choose a stronger password (at least 6 characters)."
    "auth/too-many-requests"      -> "Too many attempts. Wait a minute and try again."
    "auth/network-request-failed" -> "Network hiccup. Try again."
    "auth/no-current-user"        -> "You're signed out. Sign in again to change this."
    else                          -> "Couldn't complete that change: $code"
}

@Serializable
data class AuthUser(
    val uid: String,
    val email: String?,
)

/**
 * #886: the code [mapIdentityToolkitError] gives `beforeSignIn`'s refusal of a
 * locked account. Not a Firebase code; Identity Toolkit reports the refusal as
 * `BLOCKING_FUNCTION_ERROR_RESPONSE` and only the server's sentence says why.
 */
const val ACCOUNT_LOCKED_CODE = "auth/account-locked"

/** Names the control on the sign-in screen that clears a lock: a password reset. */
const val ACCOUNT_LOCKED_MSG =
    "This account is locked after too many sign-in attempts. Use \"Forgot password?\" below to reset the password, then sign in with the new one."

/**
 * #886: the sign-in failures that count toward a lockout. Wrong password, no
 * such user, and the enumeration-protected form of either. Never a network
 * failure, too-many-requests, a disabled user, a malformed email or the locked
 * refusal.
 */
fun shouldReportFailedLogin(code: String): Boolean =
    code == "auth/wrong-password" || code == "auth/user-not-found" || code == "auth/invalid-credential"

sealed class SignInResult {
    data class Ok(val user: AuthUser) : SignInResult()
    data class Failure(val code: String) : SignInResult() {
        val friendly: String get() = when (code) {
            ACCOUNT_LOCKED_CODE         -> ACCOUNT_LOCKED_MSG
            "auth/invalid-email"        -> "That email doesn't look right."
            "auth/user-not-found",
            "auth/invalid-credential",
            "auth/wrong-password"       -> "Email or password didn't match."
            "auth/too-many-requests"    -> "Too many attempts. Wait a minute and try again."
            "auth/network-request-failed" -> "Network hiccup. Try again."
            else                        -> "Couldn't sign you in: $code"
        }
    }
}

internal expect fun platformAuthStateStream(): Flow<AuthUser?>
internal expect suspend fun platformSignIn(email: String, password: String): SignInResult
/** #886: unauthenticated `recordFailedLogin` report. Throws on failure; [AuthClient] swallows it. */
internal expect suspend fun platformReportFailedLogin(email: String)
internal expect suspend fun platformSignOut()
internal expect suspend fun platformSendPasswordReset(email: String): Boolean
internal expect suspend fun platformIdToken(forceRefresh: Boolean): String?
internal expect suspend fun platformIsCurrentUserAdmin(forceRefresh: Boolean): Boolean
/** Raw `testTribeId` custom claim off the current ID token, or null when absent / signed out. */
internal expect suspend fun platformTestTribeId(forceRefresh: Boolean): String?
internal expect suspend fun platformUpdateEmail(currentPassword: String, newEmail: String): AuthOpResult
internal expect suspend fun platformUpdatePassword(currentPassword: String, newPassword: String): AuthOpResult

// 02-sign-in item 1: password-manager autofill on web (Wasm renders to <canvas>, so
// there is no real DOM login form for a manager to see). The web actual injects a
// visually-hidden <form> with autocomplete username/current-password inputs and bridges
// their values into Compose state; submit() triggers the browser's save prompt. The
// jvm/desktop actual is a no-op (native autofill is the platform's job there).
internal expect fun platformMountSignInAutofill(onCredentials: (email: String, password: String) -> Unit)
internal expect fun platformSetSignInAutofillValues(email: String, password: String)
internal expect fun platformSubmitSignInAutofill()
internal expect fun platformUnmountSignInAutofill()
