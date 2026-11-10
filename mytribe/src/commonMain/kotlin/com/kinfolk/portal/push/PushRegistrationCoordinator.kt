package com.kinfolk.portal.push

import com.kinfolk.portal.portal.PortalApi
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
/**
 * What this device last learned about its own push registration (#1787). Shown
 * on Notification Settings so a failed registration is no longer log-only.
 * Nothing here carries a token value.
 */
sealed interface DevicePushState {
    /** No attempt has finished yet (or the kinfolk signed out). */
    data object Unknown : DevicePushState
    /** The backend has this device's token. */
    data object Registered : DevicePushState
    /** The platform has no push token to give (desktop, or the browser said no). Not a failure to retry. */
    data object Unavailable : DevicePushState
    /** [stage] is `token`, `register` or `unregister`; [detail] is `ExceptionClass: message`. */
    data class Failed(val stage: String, val detail: String) : DevicePushState
}
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
    private val _state = MutableStateFlow<DevicePushState>(DevicePushState.Unknown)
    /** Latest outcome of a token fetch or register call; see [DevicePushState]. */
    val state: StateFlow<DevicePushState> = _state.asStateFlow()
    /**
     * Retry button: forget the cached token and run the sign-in path again, so
     * a failed token fetch or register call gets another try without waiting
     * for the next launch. Safe to call when already registered.
     */
    suspend fun retry() {
        registeredToken = null
        onSignedIn()
    }

    /** Call when auth state resolves to SignedIn. Safe to call repeatedly. */
    suspend fun onSignedIn() {
        // A new attempt starts clean, so a stale failure cannot outlive a clean "no token" answer.
        if (_state.value is DevicePushState.Failed) _state.value = DevicePushState.Unknown
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
        }
        if (token == null) {
            // A failure already set Failed; a clean null is "this platform has no token".
            if (_state.value !is DevicePushState.Failed) _state.value = DevicePushState.Unavailable
            return
        }
        register(token)
    }

    /** Call when the platform issues a replacement token mid-session. */
    suspend fun onTokenRefreshed(token: String) {
        register(token)
    }

    /** Call BEFORE backend.signOut() so the callable still has auth. */
    suspend fun onSignOut() {
        _state.value = DevicePushState.Unknown
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
        if (token == registeredToken) {
            _state.value = DevicePushState.Registered
            return
        }
        try {
            withTimeout(stepTimeoutMs) { portalApi.registerFcmToken(token, platform, appVersion) }
            registeredToken = token
            _state.value = DevicePushState.Registered
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
    private fun logFailure(stage: String, t: Throwable) {
        val detail = "${t::class.simpleName}: ${t.message}"
        logger("$stage failed: $detail")
        // An unregister failure on sign-out is not something the kinfolk can act on.
        if (stage != "unregister") _state.value = DevicePushState.Failed(stage, detail)
    }

    private companion object {
        /** Longest the token fetch or the register call may take before it is logged as a timeout. */
        const val STEP_TIMEOUT_MS = 30_000L
    }
}
