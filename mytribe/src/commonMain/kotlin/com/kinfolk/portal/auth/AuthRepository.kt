package com.kinfolk.portal.auth

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow

interface AuthBackend {
    suspend fun currentUser(): AuthState
    suspend fun signInWithEmailPassword(email: String, password: String): AuthState.SignedIn
    suspend fun signInWithCustomToken(token: String): AuthState.SignedIn
    suspend fun sendMagicLink(email: String)
    suspend fun signInWithMagicLink(email: String, link: String): AuthState.SignedIn
    suspend fun signInWithIdToken(provider: AuthProviderId, idToken: String, rawNonce: String?): AuthState.SignedIn
    suspend fun signInWithPhoneOtp(verificationId: String, smsCode: String): AuthState.SignedIn
    suspend fun signOut()

    /**
     * Sends a reset link that continues to [continueUrl] once the password is
     * set, or a bare link when it is null. #936 gave this the parameter; see
     * [AuthRepository.sendPasswordReset] for who passes what.
     */
    suspend fun sendPasswordReset(email: String, continueUrl: String?)
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

    /**
     * #905: reads an email action code (reset, verify, change, recover) without
     * using it. The default throws [EmailActionUnsupportedException]: only the
     * Firebase SDK backend (Android, web) can do this, so desktop and test fakes
     * need nothing, and the screen tells a desktop reader to use a browser.
     */
    suspend fun readActionCode(oobCode: String): ActionCodeInfo = throw EmailActionUnsupportedException()
    /** #905: uses a reset code to set [newPassword]. No incident. See [readActionCode]. */
    suspend fun confirmPasswordReset(oobCode: String, newPassword: String): Unit =
        throw EmailActionUnsupportedException()
    /** #905: uses a verify, change or recover code. See [readActionCode]. */
    suspend fun applyActionCode(oobCode: String): Unit = throw EmailActionUnsupportedException()
    /**
     * Auth state for as long as somebody collects it, not just once at boot
     * (#502).
     *
     * [currentUser] answers "who is signed in right now" and then stops
     * caring. That left the portal deaf for the whole rest of the session: a
     * session revoked by the operator, a token that stops refreshing, a
     * sign-out performed on another device, none of it reached this app until
     * something else happened to call [AuthRepository.refresh]. #454 closed the
     * same blind spot for both web apps and the Android admin; the KMP portal
     * never got its half.
     *
     * The default is a single emission of [currentUser], which is exactly what
     * the portal did before, so the REST backend and the test fakes are correct
     * without implementing anything. Only a backend with something real to
     * subscribe to needs to override it.
     */
    fun authStateChanges(): Flow<AuthState> = flow { emit(currentUser()) }

    /**
     * #886: what a failed [signInWithEmailPassword] means for the lockout. The
     * default reads this platform's error code off [t] ([platformAuthErrorCode])
     * and the refusal text, which is right for the Firebase and REST backends and
     * harmless for a fake: a fake's plain exception classifies as
     * [SignInFailureKind.Other] and is never reported.
     */
    fun classifySignInFailure(t: Throwable): SignInFailureKind =
        classifySignInFailure(platformAuthErrorCode(t), t.message ?: t.toString())

    /**
     * #886: tell `recordFailedLogin` that a sign-in failed on a credential error.
     * Unauthenticated; the server answers `{ ok: true }` for every email, so
     * nothing reads a result. Default no-op for backends with no server to tell.
     */
    suspend fun reportFailedLogin(email: String) {}
}

/**
 * #886: the one scope every [AuthRepository] launches its failed-login reports
 * in. Process-lifetime on purpose: a report is a single short callable that
 * must outlive the screen that fired it, and one shared scope means a rebuilt
 * repository never leaves an orphaned `SupervisorJob` behind.
 */
internal val sharedAuthReportScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

class AuthRepository(
    private val backend: AuthBackend,
    /**
     * #886: where a failed sign-in's report runs, detached from the sign-in so
     * the error reaches the screen without waiting on it. Production shares
     * [sharedAuthReportScope]; tests pass `Unconfined`.
     */
    private val reportScope: CoroutineScope = sharedAuthReportScope,
) {
    /** Test seam: which scope reports run in. */
    internal val reportScopeForTest: CoroutineScope get() = reportScope

    /**
     * #886: whether [t], thrown by [signInWithEmailPassword], was a wrong password
     * or unknown email, so a screen can say so plainly instead of treating it as
     * a fault. Never throws.
     */
    fun isCredentialFailure(t: Throwable): Boolean =
        try {
            backend.classifySignInFailure(t) == SignInFailureKind.Credentials
        } catch (_: Throwable) {
            false
        }

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
    /**
     * Follows [AuthBackend.authStateChanges] until the caller's scope is
     * cancelled, which is the lifecycle: the composable that starts this owns
     * it, and leaving the composition ends it. Suspends for as long as it is
     * collecting, so it belongs in its own LaunchedEffect and not in front of
     * anything that needs to run after it.
     *
     * No [AuthState.Loading] per emission. Loading is the state before the
     * first answer arrives, and the flow's own first emission is that answer;
     * setting it again on every later transition would flash a spinner over a
     * screen the kinfolk is already using.
     *
     * A throw is [AuthState.Unreachable], never [AuthState.SignedOut], for the
     * same reason [refresh] does it (#494): a subscription that dies is the
     * subscription failing, not a statement about whether anybody is signed in.
     * Collection stops there, because the flow is done either way; the retry
     * path is the launch error's, which calls [refresh].
     */
    suspend fun observe() {
        try {
            backend.authStateChanges().collect { resolved ->
                println("[Auth] observe() -> ${resolved::class.simpleName}" +
                    (if (resolved is AuthState.SignedIn) " uid=${resolved.uid}" else ""))
                _state.value = resolved
            }
        } catch (c: CancellationException) {
            // The composable left. That is this subscription ending normally,
            // not the sign-in service failing, and writing Unreachable here
            // would have stamped a teardown onto the state a returning screen
            // reads back. Rethrow so the cancelling scope still completes.
            throw c
        } catch (t: Throwable) {
            println("[Auth] observe() THREW ${t::class.simpleName}: ${t.message}")
            _state.value = AuthState.Unreachable(t.message)
        }
    }

    /**
     * #886: a credential failure is reported to `recordFailedLogin` in the
     * background and the original error is rethrown at once; `beforeSignIn`'s
     * locked refusal becomes [AccountLockedException] so the screen can say so.
     * Classified OUTSIDE [withRecaptchaGuard], after its one transparent retry,
     * so a reCAPTCHA-shaped rejection is never counted as a guessed password.
     * SignInScreen and ClaimInviteScreen both sign in through here.
     */
    suspend fun signInWithEmailPassword(email: String, password: String) {
        val signedIn = try {
            withRecaptchaGuard { backend.signInWithEmailPassword(email, password) }
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            val kind = try {
                backend.classifySignInFailure(t)
            } catch (_: Throwable) {
                SignInFailureKind.Other
            }
            when (kind) {
                SignInFailureKind.Credentials -> reportInBackground(email.trim())
                SignInFailureKind.Locked -> throw AccountLockedException(t)
                SignInFailureKind.Other -> Unit
            }
            throw t
        }
        _state.value = signedIn
    }

    /** Fire and forget. Swallows and logs its own failures. */
    private fun reportInBackground(email: String) {
        try {
            reportScope.launch {
                try {
                    backend.reportFailedLogin(email)
                } catch (c: CancellationException) {
                    throw c
                } catch (t: Throwable) {
                    println("[Auth] recordFailedLogin report failed: ${t::class.simpleName}: ${t.message}")
                }
            }
        } catch (t: Throwable) {
            println("[Auth] recordFailedLogin report could not start: ${t.message}")
        }
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

    /**
     * Sends a password reset link to [email].
     *
     * #911: an address Firebase has never seen is NOT an error here. Both
     * Kotlin clients now send through Firebase's own reset, which refuses an
     * unknown address whenever the project's email enumeration protection is
     * off, and a screen that showed that refusal would answer "is this an
     * account?" for anyone who can type. The refusal is absorbed, so the screen
     * shows the same sentence it shows for a real account, exactly as the
     * `requestPasswordReset` callable's constant `{ ok: true }` used to. See
     * [isUnknownAccountOnReset]; nothing else is absorbed.
     *
     * #936: [continueUrl] is where the link continues once the password is set,
     * the same parameter portal web's `sendReset(email, continueUrl)` takes and
     * with the same two defaults: the portal sign-in unless a caller says
     * otherwise, and a bare link for an explicit null. The email action screen
     * passes the target the original link carried, through [safeContinueUrl],
     * so a replacement link can only continue somewhere the allowlist allows.
     */
    suspend fun sendPasswordReset(email: String, continueUrl: String? = EmailAction.PORTAL_SIGN_IN_URL) {
        try {
            withRecaptchaGuard { backend.sendPasswordReset(email, continueUrl) }
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            if (!isUnknownAccountOnReset(t)) throw t
        }
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

    /** #905: see [AuthBackend.readActionCode]. */
    suspend fun readActionCode(oobCode: String): ActionCodeInfo =
        withRecaptchaGuard { backend.readActionCode(oobCode) }
    /** #905: see [AuthBackend.confirmPasswordReset]. */
    suspend fun confirmPasswordReset(oobCode: String, newPassword: String) {
        withRecaptchaGuard { backend.confirmPasswordReset(oobCode, newPassword) }
    }
    /** #905: see [AuthBackend.applyActionCode]. */
    suspend fun applyActionCode(oobCode: String) {
        withRecaptchaGuard { backend.applyActionCode(oobCode) }
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
    override suspend fun sendPasswordReset(email: String, continueUrl: String?) = Unit
    override suspend fun changePassword(currentPassword: String, newPassword: String) = Unit
    override suspend fun changeEmail(currentPassword: String, newEmail: String) = Unit
}
