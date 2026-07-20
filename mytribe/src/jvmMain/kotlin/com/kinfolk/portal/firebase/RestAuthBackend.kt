package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.AuthBackend
import com.kinfolk.portal.auth.AuthProviderId
import com.kinfolk.portal.auth.AuthState
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Desktop AuthBackend backed by Firebase Auth REST.
 * Holds the current idToken in memory; persists refreshToken to JvmTokenStore.
 */
internal class RestAuthBackend(
    private val rest: RestAuthClient = RestAuthClient(),
) : AuthBackend {

    private val mutex = Mutex()
    @Volatile private var cachedIdToken: String? = null
    @Volatile private var cachedExpiryMs: Long = 0L

    /** Current id token, refreshing if needed. Null when signed out. */
    suspend fun idToken(): String? = mutex.withLock {
        val now = System.currentTimeMillis()
        val cached = cachedIdToken
        if (cached != null && now < cachedExpiryMs - 30_000L) return cached
        val rt = JvmTokenStore.refreshToken ?: return null
        val (newToken, _) = rest.refresh(rt)
        cachedIdToken = newToken
        // Tokens last 1h; refresh sets expires_in but we don't parse it strictly here.
        cachedExpiryMs = now + 55 * 60 * 1000L
        newToken
    }

    override suspend fun currentUser(): AuthState {
        val rt = JvmTokenStore.refreshToken ?: return AuthState.SignedOut
        return try {
            val (idToken, uid) = rest.refresh(rt)
            cachedIdToken = idToken
            cachedExpiryMs = System.currentTimeMillis() + 55 * 60 * 1000L
            JvmTokenStore.uid = uid
            val email = JvmTokenStore.email
            val displayName = JvmTokenStore.displayName
            // Best-effort sync with current account state.
            try {
                val u = rest.lookup(idToken)
                if (u != null) {
                    JvmTokenStore.email = u.email
                    JvmTokenStore.displayName = u.displayName
                    return AuthState.SignedIn(uid, u.email ?: email, u.displayName ?: displayName)
                }
            } catch (_: Throwable) { /* fall through to cached */ }
            AuthState.SignedIn(uid, email, displayName)
        } catch (_: Throwable) {
            JvmTokenStore.clear()
            cachedIdToken = null
            AuthState.SignedOut
        }
    }

    override suspend fun signInWithEmailPassword(email: String, password: String): AuthState.SignedIn {
        val res = rest.signInWithPassword(email, password)
        JvmTokenStore.refreshToken = res.refreshToken
        JvmTokenStore.uid = res.localId
        JvmTokenStore.email = res.email
        JvmTokenStore.displayName = res.displayName
        cachedIdToken = res.idToken
        cachedExpiryMs = System.currentTimeMillis() + 55 * 60 * 1000L
        return AuthState.SignedIn(res.localId, res.email, res.displayName)
    }

    override suspend fun signInWithCustomToken(token: String): AuthState.SignedIn {
        val res = rest.signInWithCustomToken(token)
        JvmTokenStore.refreshToken = res.refreshToken
        cachedIdToken = res.idToken
        cachedExpiryMs = System.currentTimeMillis() + 55 * 60 * 1000L
        // Custom-token response has no profile; resolve uid/email via lookup.
        val user = rest.lookup(res.idToken)
            ?: throw IllegalStateException("custom-token sign-in: account lookup failed")
        JvmTokenStore.uid = user.localId
        JvmTokenStore.email = user.email
        JvmTokenStore.displayName = user.displayName
        return AuthState.SignedIn(user.localId, user.email, user.displayName)
    }

    override suspend fun sendMagicLink(email: String) {
        throw NotImplementedError("Magic-link sign-in not wired on desktop yet.")
    }

    override suspend fun signInWithMagicLink(email: String, link: String): AuthState.SignedIn {
        throw NotImplementedError("Magic-link sign-in not wired on desktop yet.")
    }

    override suspend fun signInWithIdToken(
        provider: AuthProviderId,
        idToken: String,
        rawNonce: String?,
    ): AuthState.SignedIn {
        throw NotImplementedError("Provider sign-in not wired on desktop yet ($provider).")
    }

    override suspend fun signInWithPhoneOtp(verificationId: String, smsCode: String): AuthState.SignedIn {
        throw NotImplementedError("Phone OTP not wired on desktop yet.")
    }

    override suspend fun signOut() {
        cachedIdToken = null
        cachedExpiryMs = 0L
        JvmTokenStore.clear()
    }

    override suspend fun sendPasswordReset(email: String) {
        rest.sendPasswordReset(email)
    }

    override suspend fun changePassword(currentPassword: String, newPassword: String) {
        val email = JvmTokenStore.email ?: throw IllegalStateException("no-email-on-account")
        // Reauthenticate by re-signing in, then update with the fresh idToken.
        val signIn = rest.signInWithPassword(email, currentPassword)
        val updated = rest.update(idToken = signIn.idToken, password = newPassword)
        updated.refreshToken?.let { JvmTokenStore.refreshToken = it }
        cachedIdToken = updated.idToken ?: signIn.idToken
        cachedExpiryMs = System.currentTimeMillis() + 55 * 60 * 1000L
    }

    override suspend fun changeEmail(currentPassword: String, newEmail: String) {
        val email = JvmTokenStore.email ?: throw IllegalStateException("no-email-on-account")
        val signIn = rest.signInWithPassword(email, currentPassword)
        val updated = rest.update(idToken = signIn.idToken, email = newEmail)
        JvmTokenStore.email = updated.email ?: newEmail
        updated.refreshToken?.let { JvmTokenStore.refreshToken = it }
        cachedIdToken = updated.idToken ?: signIn.idToken
        cachedExpiryMs = System.currentTimeMillis() + 55 * 60 * 1000L
    }
}
