package com.kinfolk.portal.push

import com.kinfolk.portal.portal.PortalApi
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
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
    /**
     * #1808: a token fetch or register call is running right now. Notification
     * Settings shows "Signing up this device…" for it, so a sign-up still in
     * flight is no longer the same blank as a finished one.
     */
    data object Registering : DevicePushState
    /** The backend has this device's token: registerFcmToken succeeded. */
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
    /** #1788: whether the device will show a push; the Enable and Blocked cards read it. */
    val permissionGate: NotificationPermissionGate = NotApplicableNotificationGate,
    /**
     * #1809: where a Retry tapped on a card runs. It has to outlive the card:
     * on Home the card leaves composition the moment Retry clears the failure,
     * and a Retry launched in the card's own scope was cancelled with it. The
     * app passes its root composition scope, the one sign-out already runs in.
     */
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    var registeredToken: String? = null
        private set
    private val _state = MutableStateFlow<DevicePushState>(DevicePushState.Unknown)
    /** Latest outcome of a token fetch or register call; see [DevicePushState]. */
    val state: StateFlow<DevicePushState> = _state.asStateFlow()
    private val _homeCardDismissed = MutableStateFlow(false)
    /** "Maybe later" / "Close" on the Home card, for this session only, as on the web portal. */
    val homeCardDismissed: StateFlow<Boolean> = _homeCardDismissed.asStateFlow()
    fun dismissHomeCard() {
        _homeCardDismissed.value = true
    }
    /**
     * Retry button: forget the cached token and run the sign-in path again, so
     * a failed token fetch or register call gets another try without waiting
     * for the next launch. Safe to call when already registered.
     */
    suspend fun retry() {
        registeredToken = null
        onSignedIn()
    }

    private val _retrying = MutableStateFlow(false)
    /** True while a Retry started by [startRetry] is running; the Finish card's button reads it. */
    val retrying: StateFlow<Boolean> = _retrying.asStateFlow()
    private var retryJob: Job? = null
    /**
     * The Retry button (#1809): runs [retry] in the coordinator's [scope], so it
     * finishes even when the card that asked for it leaves composition. A tap
     * while one is already running joins that one instead of starting another.
     */
    fun startRetry(): Job {
        retryJob?.takeIf { it.isActive }?.let { return it }
        _retrying.value = true
        val job = scope.launch {
            try {
                retry()
            } finally {
                _retrying.value = false
            }
        }
        retryJob = job
        return job
    }

    /** Bumped on sign-out, so an attempt interrupted by it ends blank rather than as a failure. */
    private var signInGeneration = 0
    /** The step the running attempt is on, for the line an interrupted attempt leaves behind. */
    private var stage = "token"

    /** Call when auth state resolves to SignedIn. Safe to call repeatedly. */
    suspend fun onSignedIn() {
        val generation = signInGeneration
        // A new attempt starts clean, so a stale failure cannot outlive a clean
        // "no token" answer. #1808: and it says it is running. A device already
        // registered keeps saying so while the token is refreshed.
        if (_state.value !is DevicePushState.Registered) _state.value = DevicePushState.Registering
        try {
            attemptRegistration()
        } finally {
            // Every normal exit leaves Registered, Unavailable or Failed. Only a
            // cancelled run gets here still Registering. Sign-out cancelling it
            // is the one case that should end blank. Anything else (#1809: the
            // scope that ran it went away) is an attempt that did not finish,
            // so it ends as a failure with a Retry, never as a blank card.
            if (_state.value == DevicePushState.Registering) {
                _state.value = if (generation != signInGeneration) {
                    DevicePushState.Unknown
                } else {
                    DevicePushState.Failed(stage, INTERRUPTED_DETAIL)
                }
            }
        }
    }

    private suspend fun attemptRegistration() {
        stage = "token"
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
        // A Retry still running belongs to the session being torn down: stop
        // it before the token is forgotten, so it cannot register afterwards.
        signInGeneration += 1
        retryJob?.cancelAndJoin()
        retryJob = null
        _state.value = DevicePushState.Unknown
        _homeCardDismissed.value = false
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
        stage = "register"
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
        /** [DevicePushState.Failed.detail] for an attempt that was stopped part way, same `Class: message` shape. */
        const val INTERRUPTED_DETAIL = "CancellationException: stopped before it finished"
    }
}
