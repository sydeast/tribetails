package com.tribetails.auntieos.web.data

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The desktop admin's half of #557 (issue #573): noticing that the backend has
 * declared this session over, and ending it here too.
 *
 * ---------------------------------------------------------------------------
 * FOUR THINGS THAT ALL LOOK LIKE A REFUSED CALLABLE, AND WHY ONLY ONE ENDS THE
 * SESSION
 * ---------------------------------------------------------------------------
 *  1. NOT SIGNED IN — a bare `Unauthenticated`. `App.kt`'s auth gate already
 *     owns this; reacting here would fight it.
 *  2. NOT AUTHORIZED — a permission refusal. The operator's session is fine and
 *     this particular call is not theirs to make. Signing them out would be a
 *     lie about what happened.
 *  3. THE NETWORK, OR A CANCELLATION — a connection that dropped, a screen that
 *     went away mid-call. Retrying is the answer to both, and usually works.
 *  4. SESSION REVOKED, OR ACCOUNT DISABLED — `functions/src/lib/
 *     sessionRevocation.ts` tags these, and no amount of retrying clears them.
 *     The session is over; the only way forward is to sign in again.
 *
 * Only 4 tears anything down.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MATCHES ON THE MESSAGE, AND WHY THAT IS NOT PROSE MATCHING
 * ---------------------------------------------------------------------------
 * Everything on this surface arrives as [WriteResult.Err], which carries a
 * STRING and nothing else. `JvmFirestoreRest.callable` reads `error.message` out
 * of the callable envelope and throws the rest away, so `details.reason` — the
 * clean channel the React admin reads — does not exist by the time the result
 * gets here.
 *
 * That is exactly the case the backend was written for.
 * `sessionRevocation.ts` sends the machine-readable reason TWICE, in
 * `details.reason` and inside the message, and its header says in as many words
 * to keep both or the non-web clients go deaf. The same reasoning already
 * decided `GalleryController.isPermissionDenied` in the portal. What is matched
 * is a namespaced token that appears nowhere else — never wording like
 * "session" or "revoked" on its own — so the three non-triggers above, whose
 * messages are written by Firebase and by the platform rather than by us, fall
 * out on their own.
 */
enum class SessionEndedReason {
    /** `signOutAllDevices`, a sign-out elsewhere, or a password change. */
    Revoked,

    /** An operator turned the account off. */
    Disabled,
}

internal const val REVOKED_TOKEN = "session-revoked"
internal const val DISABLED_TOKEN = "user-disabled"

/**
 * The reason the backend gave for refusing, or null when this failure is not one
 * it tagged.
 *
 * Disabled is checked first for the same reason the portal checks it first: a
 * disabled account is the more specific statement, and an operator who reads
 * "your session ended" when the truth is "your account was turned off" goes and
 * tries to sign in again for nothing.
 */
fun sessionEndedReason(message: String?): SessionEndedReason? {
    if (message == null) return null
    return when {
        message.contains(DISABLED_TOKEN) -> SessionEndedReason.Disabled
        message.contains(REVOKED_TOKEN) -> SessionEndedReason.Revoked
        else -> null
    }
}

/** Walks the cause chain, for the paths where a throwable reaches us instead. */
fun sessionEndedReason(t: Throwable?): SessionEndedReason? {
    var cursor = t
    var depth = 0
    while (cursor != null && depth < 8) {
        sessionEndedReason("${cursor.message.orEmpty()} $cursor")?.let { return it }
        cursor = cursor.cause
        depth++
    }
    return null
}

/** What the sign-in screen says after an involuntary sign-out. */
fun sessionEndedMessage(reason: SessionEndedReason): String = when (reason) {
    SessionEndedReason.Disabled -> "This account has been turned off. Ask another operator to turn it back on."
    SessionEndedReason.Revoked -> "Your session ended, so we signed you out. Please sign in again."
}

/**
 * A one-shot handoff from "the call was refused" to "the sign-in screen explains
 * why".
 *
 * Deliberately a plain singleton and not a parameter threaded through the
 * composition: the refusal happens inside the callable seam, several layers
 * below anything holding UI state, and the alternative is a callback passed
 * through every screen for a message shown once. [consume] clears as it reads,
 * so the notice cannot reappear on a recomposition or a later visit to the
 * sign-in screen.
 */
object SessionEndedNotice {
    private var pending: String? = null

    fun record(reason: SessionEndedReason) {
        pending = sessionEndedMessage(reason)
    }

    fun consume(): String? {
        val notice = pending
        pending = null
        return notice
    }

    /** Test seam: forget anything recorded. */
    fun clear() {
        pending = null
    }
}

/**
 * Wraps the one function every desktop callable passes through so a refusal that
 * means "this session is over" ends the session here too.
 *
 * WHY THE DECORATOR, AND NOT A CHECK IN EACH REPOSITORY. `platformInvokeCallable`
 * has well over a hundred call sites across `FirestoreClient`, `TemplateService`
 * and the screen-level clients, and every one of them has its own `when (r)`.
 * One of them forgetting to react is a hole, and it is the kind nobody finds
 * until an operator is stuck staring at a screen where nothing works. The
 * platform seam is the one thing they all go through, exactly as `wrapCallable`
 * is on the server, so the reaction is installed once and cannot be forgotten.
 *
 * WHAT ENDING THE SESSION MEANS HERE, AND WHAT IT DOES NOT. It signs the local
 * Firebase session out and nothing more. It does NOT call `signOutAllDevices` or
 * any other cleanup callable: those are AUTHENTICATED, being refused is what got
 * us here, and calling one would come straight back through this class. There is
 * also nothing left to revoke — the server already did it.
 *
 * The UI needs no wiring for this. `App.kt` collects `authStateStream()` for the
 * whole life of the window, so the sign-out below reaches the gate on its own
 * and it drops back to [SessionEndedReason]-aware `SignInScreen`.
 */
class RevocationAwareCallables(
    private val delegate: suspend (name: String, payloadJson: String) -> WriteResult<String>,
    private val endSession: suspend () -> Unit = { platformSignOut() },
) {

    private val gate = Mutex()
    private var ended = false

    suspend fun invoke(name: String, payloadJson: String): WriteResult<String> {
        val result = try {
            delegate(name, payloadJson)
        } catch (c: CancellationException) {
            // The caller's scope went away. Not a statement about the session,
            // and swallowing it here would break every timeout above us.
            throw c
        } catch (t: Throwable) {
            react(sessionEndedReason(t))
            throw t
        }

        when (result) {
            is WriteResult.Ok -> {
                // RE-ARM. The flag is a burst collapser, not a once-per-process
                // latch, and on desktop it would have been the latter: this app
                // runs for days. After one revoked session the guard would stay
                // closed, and a SECOND revocation weeks later — a password
                // change, a sign-out on another device — would be ignored,
                // leaving the operator looping on refused calls, which is the
                // exact failure this class exists to prevent. The React admin
                // hides the same shape behind its document navigation; there is
                // no navigation here.
                //
                // A call that succeeded is proof the CURRENT session works, so
                // this cannot re-open the burst it collapses: during a burst of
                // refusals there are no successes to reset it.
                if (ended) gate.withLock { ended = false }
            }
            is WriteResult.Err -> react(sessionEndedReason(result.message))
        }
        // Returned unchanged either way: this REACTS to the refusal, it does not
        // consume it. The caller's own error handling still runs and its screen
        // still says what it was going to say.
        return result
    }

    private suspend fun react(reason: SessionEndedReason?) {
        if (reason == null) return
        // Once, not once per refused call. A screen that loads fires several
        // callables at a time and every one comes back refused; signing out five
        // times over would race the auth listener against itself.
        gate.withLock {
            if (ended) return
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

    /** Test seam: forget that a teardown already ran. */
    internal suspend fun resetForTest() {
        gate.withLock { ended = false }
    }
}
