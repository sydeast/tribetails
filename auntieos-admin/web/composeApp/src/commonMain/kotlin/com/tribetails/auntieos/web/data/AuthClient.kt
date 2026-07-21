package com.tribetails.auntieos.web.data

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable

/**
 * Firebase Auth facade. wasmJs implementation talks to `window.__fb.{signIn,signOut,onAuthChange}`
 * (defined in `wasmJsMain/resources/index.html`). Future Android target will swap to GitLive
 * Firebase Auth or the official Android SDK.
 */
class AuthClient {
    /** Hot stream of the current auth state. Emits null when signed out. */
    fun authStateStream(): Flow<AuthUser?> = platformAuthStateStream()

    /** @return SignInResult.Ok with user, or SignInResult.Failure with code/message. */
    suspend fun signIn(email: String, password: String): SignInResult =
        platformSignIn(email, password)

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

sealed class SignInResult {
    data class Ok(val user: AuthUser) : SignInResult()
    data class Failure(val code: String) : SignInResult() {
        val friendly: String get() = when (code) {
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
