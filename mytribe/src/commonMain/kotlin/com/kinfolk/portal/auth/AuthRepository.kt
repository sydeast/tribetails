package com.kinfolk.portal.auth

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

interface AuthBackend {
    suspend fun currentUser(): AuthState
    suspend fun signInWithEmailPassword(email: String, password: String): AuthState.SignedIn
    suspend fun signInWithCustomToken(token: String): AuthState.SignedIn
    suspend fun sendMagicLink(email: String)
    suspend fun signInWithMagicLink(email: String, link: String): AuthState.SignedIn
    suspend fun signInWithIdToken(provider: AuthProviderId, idToken: String, rawNonce: String?): AuthState.SignedIn
    suspend fun signInWithPhoneOtp(verificationId: String, smsCode: String): AuthState.SignedIn
    suspend fun signOut()
    suspend fun sendPasswordReset(email: String)
    /** Re-auth with [currentPassword], then set [newPassword]. */
    suspend fun changePassword(currentPassword: String, newPassword: String)
    /** Re-auth with [currentPassword], then begin changing the sign-in email to [newEmail]. */
    suspend fun changeEmail(currentPassword: String, newEmail: String)

    /**
     * Forces a fresh ID token fetch from the server, picking up any custom
     * claim change (e.g. O-5's setActiveTribe re-minting `kinfolkId`) that a
     * cached token wouldn't reflect. Default no-op — only the real Firebase
     * backend needs this; REST/desktop and test fakes have nothing to refresh.
     */
    suspend fun refreshIdToken() {}
}

class AuthRepository(private val backend: AuthBackend) {
    private val _state = MutableStateFlow<AuthState>(AuthState.Loading)
    val state: StateFlow<AuthState> = _state.asStateFlow()

    suspend fun refresh() {
        println("[Auth] refresh() called")
        _state.value = AuthState.Loading
        try {
            val resolved = backend.currentUser()
            println("[Auth] refresh() resolved -> ${resolved::class.simpleName}" +
                (if (resolved is AuthState.SignedIn) " uid=${resolved.uid}" else ""))
            _state.value = resolved
        } catch (t: Throwable) {
            // #494: NOT SignedOut. Every backend answers SignedOut for a real
            // absence of a session — Firebase for a null currentUser, REST for a
            // missing refresh token — so a throwable here is the call itself
            // failing, which is a different fact and mostly means the network.
            // Reporting it as a sign-out logged people out of an app they were
            // still signed in to, and there was no third answer to give.
            println("[Auth] refresh() THREW ${t::class.simpleName}: ${t.message}")
            _state.value = AuthState.Unreachable(t.message)
        }
    }

    suspend fun signInWithEmailPassword(email: String, password: String) {
        _state.value = withRecaptchaGuard { backend.signInWithEmailPassword(email, password) }
    }

    /** Claim flow: server mints the account (claimInviteSignup) and hands back a custom token. */
    suspend fun signInWithCustomToken(token: String) {
        _state.value = withRecaptchaGuard { backend.signInWithCustomToken(token) }
    }

    suspend fun sendMagicLink(email: String) {
        backend.sendMagicLink(email)
    }

    suspend fun completeMagicLink(email: String, link: String) {
        _state.value = backend.signInWithMagicLink(email, link)
    }

    suspend fun signInWithProvider(provider: AuthProviderId, idToken: String, rawNonce: String? = null) {
        _state.value = backend.signInWithIdToken(provider, idToken, rawNonce)
    }

    suspend fun signOut() {
        backend.signOut()
        _state.value = AuthState.SignedOut
    }

    suspend fun sendPasswordReset(email: String) {
        withRecaptchaGuard { backend.sendPasswordReset(email) }
    }

    /**
     * Web first-login race: the reCAPTCHA interceptor
     * (`initializeRecaptchaConfig`, jsMain RecaptchaBootstrap.kt) initializes in
     * parallel with first paint, and an auth call issued before it's ready is
     * rejected by Identity Toolkit with HTTP 503 "Error code: 47". Two layers of
     * defense, so the user never sees that error: wait (bounded) for readiness
     * before the first attempt, and if the failure still looks like the
     * missing-token rejection, re-await and retry once transparently. Anything
     * else propagates unchanged. jvm/android awaits are no-ops.
     */
    private suspend fun <T> withRecaptchaGuard(block: suspend () -> T): T {
        awaitRecaptchaReady()
        return try {
            block()
        } catch (t: Throwable) {
            // GitLive wraps the js FirebaseError; the auth/internal-error code can
            // land in message OR only in toString(), so check both.
            if (!isRecaptchaMissingError(t.message) && !isRecaptchaMissingError(t.toString())) throw t
            println("[Auth] retrying once after reCAPTCHA-shaped rejection: ${t.message}")
            awaitRecaptchaReady()
            block()
        }
    }

    suspend fun changePassword(currentPassword: String, newPassword: String) {
        backend.changePassword(currentPassword, newPassword)
    }

    suspend fun changeEmail(currentPassword: String, newEmail: String) {
        backend.changeEmail(currentPassword, newEmail)
        // Email change updates identity; re-resolve so the UI reflects it.
        refresh()
    }

    /** See [AuthBackend.refreshIdToken]. */
    suspend fun refreshIdToken() {
        backend.refreshIdToken()
    }
}

internal class FakeAuthBackend(
    private val uid: String = "u-fake",
    private val email: String? = null,
) : AuthBackend {
    override suspend fun currentUser(): AuthState = AuthState.SignedOut
    override suspend fun signInWithEmailPassword(email: String, password: String) =
        AuthState.SignedIn(uid, this.email ?: email, null)
    override suspend fun signInWithCustomToken(token: String) =
        AuthState.SignedIn(uid, email, null)
    override suspend fun sendMagicLink(email: String) = Unit
    override suspend fun signInWithMagicLink(email: String, link: String) =
        AuthState.SignedIn(uid, email, null)
    override suspend fun signInWithIdToken(provider: AuthProviderId, idToken: String, rawNonce: String?) =
        AuthState.SignedIn(uid, email, null)
    override suspend fun signInWithPhoneOtp(verificationId: String, smsCode: String) =
        AuthState.SignedIn(uid, email, null)
    override suspend fun signOut() = Unit
    override suspend fun sendPasswordReset(email: String) = Unit
    override suspend fun changePassword(currentPassword: String, newPassword: String) = Unit
    override suspend fun changeEmail(currentPassword: String, newEmail: String) = Unit
}
