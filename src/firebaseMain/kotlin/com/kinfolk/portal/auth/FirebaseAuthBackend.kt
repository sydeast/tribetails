package com.kinfolk.portal.auth

import dev.gitlive.firebase.Firebase
import dev.gitlive.firebase.auth.EmailAuthProvider
import dev.gitlive.firebase.auth.auth
import dev.gitlive.firebase.functions.functions
import kotlinx.coroutines.flow.first

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
        auth.currentUser?.getIdToken(true)
    }
}
