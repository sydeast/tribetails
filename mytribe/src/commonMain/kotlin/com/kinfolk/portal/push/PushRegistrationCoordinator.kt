package com.kinfolk.portal.push

import com.kinfolk.portal.portal.PortalApi

/**
 * Cross-platform FCM token registration lifecycle.
 *
 * One instance lives for the whole app session (remembered in
 * KinfolkPortalAppGuarded) and is driven by auth state:
 *
 *   SignedIn  → [onSignedIn]: obtain token (this is the only point that may
 *               trigger a permission prompt — never on first paint) and call
 *               registerFcmToken(token, platform). Idempotent per token: the
 *               last successfully registered token is cached and re-sends are
 *               skipped, so repeated SignedIn emissions don't double-register.
 *   refresh   → [onTokenRefreshed]: platform push stacks that rotate tokens
 *               mid-session (Android onNewToken) funnel here. On Android the
 *               existing KinfolkFcmService also registers directly — that is
 *               safe because the server upserts fcm_tokens/{token}, and the
 *               two paths fire on disjoint events (rotation vs sign-in).
 *   SignedOut → [onSignOut]: unregister the cached token BEFORE auth is torn
 *               down (the callable requires auth), then forget it so the next
 *               sign-in registers fresh.
 *
 * All Functions failures are logged and swallowed: push is best-effort and
 * must never break sign-in/out. A failed register leaves the cache empty so a
 * later auth emission retries.
 */
class PushRegistrationCoordinator(
    private val portalApi: PortalApi,
    private val platform: String = pushPlatform,
    private val appVersion: String? = null,
    private val tokenProvider: suspend () -> String? = { obtainPushToken() },
) {
    var registeredToken: String? = null
        private set

    /** Call when auth state resolves to SignedIn. Safe to call repeatedly. */
    suspend fun onSignedIn() {
        val token = try {
            tokenProvider()
        } catch (t: Throwable) {
            log("obtainPushToken threw: ${t.message}")
            null
        } ?: return
        register(token)
    }

    /** Call when the platform issues a replacement token mid-session. */
    suspend fun onTokenRefreshed(token: String) {
        register(token)
    }

    /** Call BEFORE backend.signOut() so the callable still has auth. */
    suspend fun onSignOut() {
        val token = registeredToken ?: return
        registeredToken = null
        try {
            portalApi.unregisterFcmToken(token)
        } catch (t: Throwable) {
            log("unregisterFcmToken failed: ${t.message}")
        }
    }

    private suspend fun register(token: String) {
        if (token == registeredToken) return
        try {
            portalApi.registerFcmToken(token, platform, appVersion)
            registeredToken = token
        } catch (t: Throwable) {
            log("registerFcmToken failed: ${t.message}")
        }
    }

    private fun log(msg: String) = println("[Push] $msg")
}
