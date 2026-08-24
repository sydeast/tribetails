package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.SessionEndedNotice
import com.kinfolk.portal.auth.sessionEndedReason
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

/**
 * Wraps the platform [FunctionsClient] so a refusal that means "this session is
 * over" ends the session here too (#557).
 *
 * WHY THE DECORATOR, AND NOT A CHECK IN `PortalApi`. `PortalApi` has ~120 call
 * sites and every screen has its own catch. One of them forgetting to react is
 * a hole, and it is the kind of hole nobody finds until a kinfolk is stuck. The
 * platform client is the one thing every callable in the app passes through,
 * exactly as `wrapCallable` is on the server, so the reaction is installed once
 * — in the three `platformFunctionsClient()` actuals — and cannot be forgotten.
 *
 * WHAT ENDING THE SESSION MEANS HERE, AND WHAT IT DOES NOT. It signs the local
 * Firebase session out and nothing more. It does NOT unregister the push token
 * or call `signOutAllDevices` the way the deliberate sign-out does: both are
 * AUTHENTICATED callables, being refused is what got us here, and calling them
 * would come straight back through this class. There is also nothing left to
 * revoke — the server already did it.
 *
 * The UI needs no wiring for this. `AuthRepository.observe()` is collecting
 * `authStateChanges()` for the whole life of the app (#502), so the Firebase
 * sign-out below reaches the shell on its own and the start route drops back to
 * the sign-in screen. The reason is left in [SessionEndedNotice] for that
 * screen to read, so an involuntary sign-out never happens silently.
 */
class RevocationAwareFunctionsClient(
    private val delegate: FunctionsClient,
    private val endSession: suspend () -> Unit = { platformAuthBackend().signOut() },
) : FunctionsClient {

    private val gate = Mutex()
    private var ended = false

    override suspend fun call(name: String, payload: JsonObject?): JsonObject {
        try {
            val result = delegate.call(name, payload)
            // RE-ARM. The flag below is a burst collapser, not a once-per-app
            // latch, and on Android it would have been the latter: this client
            // is `remember`ed for the life of the process, so after one revoked
            // session the guard stayed closed and a SECOND revocation (a
            // password change, a sign-out on another device, weeks later, on
            // the same install) would have been ignored — leaving the kinfolk
            // looping on refused calls, which is the exact failure this class
            // exists to prevent. The web portal hid it behind its document
            // reload; Android has no reload.
            //
            // A call that succeeded is proof the CURRENT session works, so this
            // cannot re-open the burst it is meant to collapse: during a burst
            // of refusals there are no successes to reset it.
            if (ended) gate.withLock { ended = false }
            return result
        } catch (c: CancellationException) {
            // The caller's scope went away. Not a statement about the session,
            // and swallowing it here would break every timeout above us.
            throw c
        } catch (t: Throwable) {
            val reason = sessionEndedReason(t)
            if (reason != null) {
                // Once, not once per refused call. A screen that loads fires
                // several callables at a time and every one of them comes back
                // refused; signing out five times over would race the auth
                // listener against itself.
                gate.withLock {
                    if (!ended) {
                        ended = true
                        SessionEndedNotice.record(reason)
                        try {
                            endSession()
                        } catch (c: CancellationException) {
                            throw c
                        } catch (inner: Throwable) {
                            println("[Auth] revoked-session sign-out failed: ${inner.message}")
                        }
                    }
                }
            }
            // Rethrown either way: this reacts to the failure, it does not
            // consume it. The caller's own error handling still runs.
            throw t
        }
    }

    /** Test seam: forget that a teardown already ran. */
    internal suspend fun resetForTest() {
        gate.withLock { ended = false }
    }
}
