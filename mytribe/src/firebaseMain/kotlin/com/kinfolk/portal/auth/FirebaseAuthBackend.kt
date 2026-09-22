package com.kinfolk.portal.auth

import dev.gitlive.firebase.Firebase
import dev.gitlive.firebase.auth.ActionCodeResult
import dev.gitlive.firebase.auth.EmailAuthProvider
import dev.gitlive.firebase.auth.auth
import dev.gitlive.firebase.functions.functions
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

class FirebaseAuthBackend : AuthBackend {
    private val auth get() = Firebase.auth

    override suspend fun currentUser(): AuthState {
        // Wait for initial auth state restoration. Firebase JS SDK lazy-loads
        // persisted auth from IndexedDB; synchronous `auth.currentUser` is null
        // until the first authStateChanged emission. Without this await, every
        // page reload races the restore and reports SignedOut even when user IS
        // signed in (token persisted, just not yet rehydrated). gitlive 2.x
        // doesn't expose authStateReady(); first() returns the latest known
        // state — immediate if already restored, awaits otherwise.
        auth.authStateChanged.first()
        return auth.currentUser?.let { AuthState.SignedIn(it.uid, it.email, it.displayName) }
            ?: AuthState.SignedOut
    }

    /**
     * The subscription #502 asked for: gitlive's `authStateChanged` is a real
     * Flow, and it emits on every transition rather than only the first, so
     * mapping it is the whole implementation.
     *
     * WHAT THIS DOES AND DOES NOT NOTICE. It fires when the SDK's idea of who
     * is signed in changes: a sign-out here or on another device, a session an
     * operator revoked, an account deleted. It does NOT fire when a token
     * simply stops being renewable while the SDK still believes a user is
     * present, which is the failure #495 closed for the web apps and the
     * Android admin with a token-refresh observer. That gap is still open on
     * this client and is tracked separately (#494 filed it as KMP work); this
     * closes the state half, not the token half.
     *
     * The first emission is the same one [currentUser] awaits, so a collector
     * started at boot gets the restored-from-IndexedDB answer exactly as
     * before, with no extra round trip and no window where the portal shows a
     * sign-in screen to somebody the SDK is still rehydrating.
     */
    override fun authStateChanges(): Flow<AuthState> =
        auth.authStateChanged.map { user ->
            user?.let { AuthState.SignedIn(it.uid, it.email, it.displayName) }
                ?: AuthState.SignedOut
        }
    override suspend fun signInWithEmailPassword(email: String, password: String): AuthState.SignedIn {
        val u = auth.signInWithEmailAndPassword(email, password).user
            ?: throw IllegalStateException("auth-failed")
        return AuthState.SignedIn(u.uid, u.email, u.displayName)
    }

    override suspend fun signInWithCustomToken(token: String): AuthState.SignedIn {
        val u = auth.signInWithCustomToken(token).user
            ?: throw IllegalStateException("custom-token-sign-in-failed")
        return AuthState.SignedIn(u.uid, u.email, u.displayName)
    }

    override suspend fun sendMagicLink(email: String) {
        TODO("magic link delegated to platform; see actuals")
    }

    override suspend fun signInWithMagicLink(email: String, link: String): AuthState.SignedIn {
        TODO("magic link delegated to platform")
    }

    override suspend fun signInWithIdToken(
        provider: AuthProviderId,
        idToken: String,
        rawNonce: String?,
    ): AuthState.SignedIn {
        // Foundation stub: gitlive 1.13 credential factory differs per platform.
        // Wire native Google/Apple credential creation per-platform actuals when
        // the platform sign-in flow is implemented.
        throw NotImplementedError("provider sign-in not yet wired for $provider")
    }

    override suspend fun signInWithPhoneOtp(verificationId: String, smsCode: String): AuthState.SignedIn {
        // Foundation stub: phone-OTP credential helper differs per gitlive platform.
        throw NotImplementedError("phone OTP not yet wired")
    }

    override suspend fun signOut() = auth.signOut()

    override suspend fun sendPasswordReset(email: String) {
        val fn = Firebase.functions.httpsCallable("requestPasswordReset")
        fn.invoke(mapOf("email" to email))
    }

    /**
     * #905: what the code really is, whatever the link's `mode` says. Operation
     * names match the web SDK's `checkActionCode`, so the screen compares them
     * the same way the web page does.
     */
    override suspend fun readActionCode(oobCode: String): ActionCodeInfo =
        when (val r = auth.checkActionCode<ActionCodeResult>(oobCode)) {
            is ActionCodeResult.PasswordReset -> ActionCodeInfo(EmailAction.OP_PASSWORD_RESET, r.email)
            is ActionCodeResult.VerifyEmail -> ActionCodeInfo(EmailAction.OP_VERIFY_EMAIL, r.email)
            is ActionCodeResult.VerifyBeforeChangeEmail ->
                ActionCodeInfo(EmailAction.OP_VERIFY_AND_CHANGE_EMAIL, r.email, r.previousEmail)
            is ActionCodeResult.RecoverEmail ->
                ActionCodeInfo(EmailAction.OP_RECOVER_EMAIL, r.email, r.previousEmail)
            else -> ActionCodeInfo(EmailAction.OP_OTHER, null)
        }
    override suspend fun confirmPasswordReset(oobCode: String, newPassword: String) {
        auth.confirmPasswordReset(oobCode, newPassword)
    }
    override suspend fun applyActionCode(oobCode: String) {
        auth.applyActionCode(oobCode)
    }
    /** #886: unauthenticated report of a credential failure; see [AuthBackend.reportFailedLogin]. */
    override suspend fun reportFailedLogin(email: String) {
        Firebase.functions.httpsCallable("recordFailedLogin").invoke(mapOf("email" to email))
    }

    override suspend fun changePassword(currentPassword: String, newPassword: String) {
        val user = auth.currentUser ?: throw IllegalStateException("not-signed-in")
        val email = user.email ?: throw IllegalStateException("no-email-on-account")
        user.reauthenticate(EmailAuthProvider.credential(email, currentPassword))
        user.updatePassword(newPassword)
    }

    override suspend fun changeEmail(currentPassword: String, newEmail: String) {
        val user = auth.currentUser ?: throw IllegalStateException("not-signed-in")
        val email = user.email ?: throw IllegalStateException("no-email-on-account")
        user.reauthenticate(EmailAuthProvider.credential(email, currentPassword))
        // Sends a verification link to the NEW address; the change applies once
        // the user confirms (preferred over the deprecated updateEmail).
        user.verifyBeforeUpdateEmail(newEmail)
    }

    override suspend fun refreshIdToken() {
        // forceRefresh=true bypasses the cached token so a just-changed custom
        // claim (O-5's setActiveTribe) is reflected immediately rather than
        // waiting up to an hour for the SDK's normal refresh cycle.
        //
        // #494: the `?.` used to swallow the one case worth knowing about. With
        // no current user nothing is minted, and the caller was told the refresh
        // had happened — so an invitee who really had verified their address got
        // refused a second time by the stale token, and nothing anywhere named
        // the reason. Saying so lets ClaimInviteScreen put a real sentence on
        // the screen instead.
        val user = auth.currentUser ?: error("No signed-in user to refresh a token for")
        user.getIdToken(true)
    }
}
