package com.tribetails.auntieos.session

import com.google.firebase.auth.FirebaseAuth
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * The observer that was missing (#454). See [SessionHealth] for what this app
 * used to do about a failed token refresh, which was nothing at all.
 *
 * HOW IT PROBES, AND WHY IT IS CHEAP. `getIdToken(false)` hands back the cached
 * token without touching the network unless that token is close to expiring, so
 * the probe costs nothing for most of a token's hour and reaches the network
 * exactly when the SDK would have had to anyway. It is also why a blip in the
 * middle of a token's life reports healthy, which is correct: while the cached
 * token is still valid nothing the operator does is being refused, and a banner
 * then would be crying wolf. The session is only called degraded once a refresh
 * is genuinely needed and cannot be had.
 *
 * LIFECYCLE. Driven off `AuntieRepository.authStateFlow()`, exactly like
 * [com.tribetails.auntieos.voice.VoiceRegistrationCoordinator] and for the same
 * reason: the event this depends on is an admin signing in, which happens long
 * after `Application.onCreate`. One collector, held as a [Job] so it can be
 * stopped, because a collector on a never-cancelled application scope is the
 * hazard that #425 was.
 */
object SessionHealthMonitor {

    private val _state = MutableStateFlow<SessionHealth>(SessionHealth.Ok)

    /**
     * Observable, because a log line is not a user-visible failure. The app
     * shell binds to this in `ui/Navigation.kt`, beside the TEST MODE and voice
     * registration banners, so a session that has stopped renewing itself says
     * so on every screen instead of only in Sentry.
     */
    val state: StateFlow<SessionHealth> = _state.asStateFlow()

    /**
     * Ask the SDK for a token. Behind a seam so a test can refuse without a
     * live Firebase. Returns failure carrying whatever the SDK threw.
     */
    private var probe: suspend () -> Result<Unit> = ::probeCurrentUserToken

    /**
     * The wait between probes, behind a seam. A test that really slept a minute
     * to prove a backoff works is a test nobody runs, so this defaults to
     * [delay] and a test hands in a recorder that returns immediately and keeps
     * the durations. Same seam as `VoiceTokenManager.backoff`.
     */
    private var waitFor: suspend (Long) -> Unit = { delay(it) }

    private var authJob: Job? = null
    private var probeJob: Job? = null

    /**
     * Begin following [sessionUids], where each element is the signed-in admin's
     * UID or `null` for signed out. Replaces any collection already running, so
     * calling this twice leaves one collector rather than two racing ones.
     */
    fun start(scope: CoroutineScope, sessionUids: Flow<String?>) {
        authJob?.cancel()
        authJob = scope.launch {
            sessionUids.distinctUntilChanged().collect { uid ->
                stopProbing()
                if (uid != null) probeJob = scope.launch { probeLoop() }
            }
        }
    }

    /** Stop following the auth state and stop probing. Idempotent. */
    fun stop() {
        authJob?.cancel()
        authJob = null
        stopProbing()
    }

    private fun stopProbing() {
        probeJob?.cancel()
        probeJob = null
        _state.value = SessionHealth.Ok
    }

    /**
     * Probe, publish, wait, repeat — until the session is signed out (the job is
     * cancelled) or a failure arrives that retrying cannot fix.
     */
    private suspend fun probeLoop() {
        var wait = SESSION_PROBE_INTERVAL_MILLIS
        while (true) {
            waitFor(wait)
            val error = probe().exceptionOrNull()
            if (error == null) {
                _state.value = SessionHealth.Ok
                wait = SESSION_PROBE_INTERVAL_MILLIS
                continue
            }
            if (!isRetryableRefreshFailure(error)) {
                // Retrying cannot mint a token this session. Stop and say so.
                AuntieLog.e("Session cannot renew its sign-in; re-authentication needed", error)
                _state.value = SessionHealth.Expired
                return
            }
            val failures = (_state.value as? SessionHealth.Unreachable)?.failures?.plus(1) ?: 1
            // Reported once per episode, not once per retry: a five-minute
            // outage should be one Sentry event, not sixty.
            if (failures == 1) {
                AuntieLog.e("Session token refresh refused by the network; retrying", error)
            }
            _state.value = SessionHealth.Unreachable(failures)
            wait = sessionRetryDelayMillis(failures)
        }
    }

    /**
     * Test seam. An `object` keeps its fields for the life of the JVM, and the
     * unit-test suite is one JVM, so without this a passing test would leave a
     * degraded state behind for the next one.
     */
    internal fun configureForTests(
        probe: suspend () -> Result<Unit>,
        waitFor: suspend (Long) -> Unit,
    ) {
        stop()
        this.probe = probe
        this.waitFor = waitFor
        _state.value = SessionHealth.Ok
    }

    internal fun resetForTests() {
        stop()
        probe = ::probeCurrentUserToken
        waitFor = { delay(it) }
        _state.value = SessionHealth.Ok
    }
}

/**
 * The real probe: ask the signed-in user for its cached ID token.
 *
 * `forceRefresh = false` on purpose — see [SessionHealthMonitor]. A null
 * `currentUser` is a success, not a failure: nobody being signed in is not a
 * broken session, and the auth collector is already about to stop this loop.
 *
 * `authProvider` is a parameter with a default for the same reason
 * `AuthGate` and `AuntieRepository` take one: it is the seam a mockk test uses
 * to hand back a `Task` that fails.
 */
internal suspend fun probeCurrentUserToken(
    authProvider: () -> FirebaseAuth = { FirebaseAuth.getInstance() },
): Result<Unit> = runCatching {
    val user = authProvider().currentUser
    if (user != null) {
        user.getIdToken(false).await()
    }
}
