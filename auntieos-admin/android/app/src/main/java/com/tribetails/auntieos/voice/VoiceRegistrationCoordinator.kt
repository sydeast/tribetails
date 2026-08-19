package com.tribetails.auntieos.voice

import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * Registers this device for inbound calls when an admin signs in, and drops the
 * registration when they sign out.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
 *
 * Voice registration used to be started from `AuntieOSApp.onCreate`, exactly
 * once, and `Application.onCreate` is the earliest code in the process. The mint
 * it started therefore ran BEFORE anybody could be signed in, and
 * `mintVoiceAccessToken` opens with `authGate.ensureAuthenticated()`. On the
 * first launch after an install, and on every launch after a sign-out, the mint
 * was refused, [VoiceTokenManager] parked on a terminal state, and nothing ever
 * asked again: the retry timer is scheduled by a SUCCESSFUL mint, `refresh()`
 * had no caller, and the only other entry point fires when FCM rotates a device
 * token, which is weeks apart. The phone stopped ringing for the whole session
 * and said nothing about it (#433).
 *
 * The ordering problem is not fixable by moving the call earlier or later in
 * `onCreate`, because the event it actually depends on (an admin signing in)
 * happens minutes afterwards, in a completely different part of the app. So this
 * waits for that event instead of guessing at it.
 *
 * ── WHAT IT LISTENS TO ────────────────────────────────────────────────────────
 *
 * `AuntieRepository.authStateFlow()`, which is already the app's answer to "is
 * an admin signed in": a `callbackFlow` over `FirebaseAuth.AuthStateListener`,
 * the same flow `AuntieNavHost` gates the whole UI on. Nothing new is invented
 * to observe sign-in, and no screen has to be open for this to work.
 *
 * It keys on the UID, not on a signed-in boolean. Signing out of one admin and
 * into another has to re-register, because a token minted for the previous
 * identity registers this phone as the wrong person, and a boolean cannot tell that
 * apart from a redundant re-emission of the same session.
 *
 * ── LIFECYCLE ─────────────────────────────────────────────────────────────────
 *
 * One collection, held as a [Job] so it can be stopped. That is not decoration:
 * the thing this replaces leaked a coroutine into the unit-test suite from every
 * Robolectric `Application` (#425), and a collector on a never-cancelled
 * application scope is the same shape of hazard. `AuntieOSApp` skips starting
 * this under Robolectric, and [stop] exists so a test that does start one can
 * prove it stops.
 */
class VoiceRegistrationCoordinator(
    private val onSignedIn: () -> Unit = VoiceTokenManager::onAdminSignedIn,
    private val onSignedOut: () -> Unit = VoiceTokenManager::onSignedOut,
) {

    private var job: Job? = null

    /**
     * Begin following [sessionUids], where each element is the signed-in admin's
     * UID or `null` for signed out. Replaces any collection already running, so
     * calling this twice leaves one collector rather than two racing ones.
     */
    fun start(scope: CoroutineScope, sessionUids: Flow<String?>) {
        job?.cancel()
        job = scope.launch {
            sessionUids.distinctUntilChanged().collect { uid ->
                if (uid == null) {
                    AuntieLog.d("Voice registration: no signed-in admin")
                    onSignedOut()
                } else {
                    AuntieLog.d("Voice registration: admin $uid signed in")
                    onSignedIn()
                }
            }
        }
    }

    /** Stop following the auth state. Idempotent. */
    fun stop() {
        job?.cancel()
        job = null
    }

    /** Whether a collection is currently running. For tests, and for logging. */
    val isRunning: Boolean
        get() = job?.isActive == true
}
