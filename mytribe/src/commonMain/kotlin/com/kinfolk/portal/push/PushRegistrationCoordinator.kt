package com.kinfolk.portal.push

import com.kinfolk.portal.portal.PortalApi
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

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
 * later auth emission retries. Each log line names the stage and the exception
 * class (#1547): `t.message` alone is the server's sentence and said nothing
 * about which step failed or what threw.
 */
class PushRegistrationCoordinator(
    private val portalApi: PortalApi,
    private val platform: String = pushPlatform,
    private val appVersion: String? = null,
    private val tokenProvider: suspend () -> String? = { obtainPushToken() },
    private val logger: (String) -> Unit = { println("[Push] $it") },
    private val stepTimeoutMs: Long = STEP_TIMEOUT_MS,
) {
    var registeredToken: String? = null
        private set

    /** Call when auth state resolves to SignedIn. Safe to call repeatedly. */
    suspend fun onSignedIn() {
        val token = try {
            withTimeout(stepTimeoutMs) { tokenProvider() }
        } catch (t: TimeoutCancellationException) {
            // A timer that ran out is a failure with a name; the parent scope
            // being cancelled is not, and is rethrown below.
            logFailure("token", t)
            null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            logFailure("token", t)
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
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            logFailure("unregister", t)
        }
    }

    private suspend fun register(token: String) {
        if (token == registeredToken) return
        try {
            withTimeout(stepTimeoutMs) { portalApi.registerFcmToken(token, platform, appVersion) }
            registeredToken = token
        } catch (t: TimeoutCancellationException) {
            logFailure("register", t)
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            logFailure("register", t)
        }
    }

    /**
     * One line per failure: the stage, the exception class and the message.
     * No token value ever goes in here. The Android token step itself logs the
     * whole throwable in PushToken.android.kt; this covers the stages that
     * only this class sees.
     */
    private fun logFailure(stage: String, t: Throwable) =
        logger("$stage failed: ${t::class.simpleName}: ${t.message}")

    private companion object {
        /** Longest the token fetch or the register call may take before it is logged as a timeout. */
        const val STEP_TIMEOUT_MS = 30_000L
    }
}
