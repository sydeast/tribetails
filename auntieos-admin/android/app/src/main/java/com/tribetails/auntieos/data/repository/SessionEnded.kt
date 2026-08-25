package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Task
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctionsException
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.util.AuntieLog
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await

/**
 * The Android admin's half of #557 (issue #573): noticing that the backend has
 * declared this session over, and ending it here too.
 *
 * ---------------------------------------------------------------------------
 * FOUR THINGS THAT ALL LOOK LIKE A REFUSED CALLABLE, AND WHY ONLY ONE ENDS THE
 * SESSION
 * ---------------------------------------------------------------------------
 *  1. NOT SIGNED IN — `UNAUTHENTICATED` with nothing else attached, or
 *     [AuthGate.SIGN_IN_REQUIRED] thrown before the call ever left. The sign-in
 *     screen already owns this; reacting here would fight it.
 *  2. NOT AUTHORIZED — `PERMISSION_DENIED`. The operator's session is fine and
 *     this particular call is not theirs to make. Signing them out would be a
 *     lie about what happened, and `VoiceTokenManager.classifyTokenFailure`
 *     already depends on that distinction holding.
 *  3. THE NETWORK, OR A CANCELLATION — a dropped connection, a `DEADLINE_EXCEEDED`,
 *     a screen that went away mid-call. Retrying is the answer to all of them.
 *  4. SESSION REVOKED, OR ACCOUNT DISABLED — `functions/src/lib/
 *     sessionRevocation.ts` tags these, and no amount of retrying clears them.
 *     The session is over; the only way forward is to sign in again.
 *
 * Only 4 tears anything down.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MATCHED, AND WHY IT IS NOT PROSE MATCHING
 * ---------------------------------------------------------------------------
 * `details` first, where the Android SDK gives us one: `FirebaseFunctionsException`
 * carries the callable's `details` payload, and the server puts `{reason: ...}`
 * there. Then the message, which carries the SAME namespaced tokens because
 * `sessionRevocation.ts` deliberately repeats them — its header says in as many
 * words to keep both or the non-web clients go deaf, and the portal's Kotlin
 * client made the same call. `GalleryController.isPermissionDenied` is the
 * existing precedent in this codebase.
 *
 * A token, never wording. `session-revoked` and `user-disabled` appear nowhere
 * else in anything Firebase or the platform writes, so the three non-triggers
 * above fall out on their own rather than by a list of exceptions.
 */
enum class SessionEndedReason {
    /** `signOutAllDevices`, a sign-out elsewhere, or a password change. */
    Revoked,

    /** An operator turned the account off. */
    Disabled,
}

internal const val REVOKED_TOKEN = "session-revoked"
internal const val DISABLED_TOKEN = "user-disabled"

private fun reasonFromText(text: String?): SessionEndedReason? = when {
    text == null -> null
    // Disabled first: it is the more specific and more actionable of the two.
    // An operator told only that their session ended goes and tries to sign in
    // again for nothing.
    text.contains(DISABLED_TOKEN) -> SessionEndedReason.Disabled
    text.contains(REVOKED_TOKEN) -> SessionEndedReason.Revoked
    else -> null
}

/**
 * The reason the backend gave for refusing, or null when this failure is not one
 * it tagged.
 *
 * Walks the cause chain, because everything on the way here wraps the original
 * at least once (`runCatching`, coroutine dispatch, the Tasks bridge).
 */
fun sessionEndedReason(t: Throwable?): SessionEndedReason? {
    var cursor = t
    var depth = 0
    while (cursor != null && depth < 8) {
        if (cursor is FirebaseFunctionsException) {
            val reason = (cursor.details as? Map<*, *>)?.get("reason") as? String
            reasonFromText(reason)?.let { return it }
        }
        reasonFromText("${cursor.message.orEmpty()} $cursor")?.let { return it }
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
 * navigation graph: the refusal happens inside the callable seam, several layers
 * below anything holding UI state, and the alternative is a callback passed
 * through every screen for a message shown once. [consume] clears as it reads,
 * so the notice cannot reappear on a recomposition or a later visit to the
 * sign-in screen.
 */
object SessionEndedNotice {
    @Volatile
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
 * Ends the local session: sign Firebase out AND drop the cached `testTribeId`.
 *
 * The two steps are one step, and getting that wrong has already been a bug
 * here once — see `AuntieRepository.endSession`, which now delegates to this.
 * Signing out while leaving the [AuthGate] claim cache populated keeps the
 * finished session's sandbox scope live for whoever signs in next, and that
 * scope decides which business's records a query may see. Naming it once means
 * the revoked-session path below cannot half-do it.
 */
fun endLocalSession(
    auth: FirebaseAuth = FirebaseAuth.getInstance(),
    gate: AuthGate = AuthGate.shared,
) {
    auth.signOut()
    gate.clearTestModeCache()
}

/**
 * The reaction itself: at most one sign-out per burst of refusals, re-armed by
 * any callable that succeeds.
 *
 * WHY A BURST GUARD. A screen that loads fires several callables at once and
 * every one of them comes back refused. Five sign-outs racing five
 * `AuthStateListener` emissions is not a thing anyone wants to debug.
 *
 * WHY IT RE-ARMS. Without the re-arm the flag is a once-per-PROCESS latch, and
 * an Android app process outlives many sessions. After one revoked session the
 * guard would stay closed, and a SECOND revocation later on the same install —
 * a password change, a sign-out on another device — would be ignored, leaving
 * the operator looping on refused calls, which is the exact failure this class
 * exists to prevent. The React admin hides the same shape behind its document
 * navigation; there is none here. A call that succeeded is proof the CURRENT
 * session works, so this cannot re-open the burst it collapses: during a burst
 * of refusals there are no successes.
 */
class RevokedSessionGuard(
    private val endSession: () -> Unit = { endLocalSession() },
) {

    private val gate = Mutex()
    private var ended = false

    /** A callable succeeded, so whatever ended before is over. */
    suspend fun noteSessionAlive() {
        if (ended) gate.withLock { ended = false }
    }

    /**
     * React to a failed callable. Returns whether this call performed the
     * teardown, which is what the tests assert on.
     */
    suspend fun react(t: Throwable): Boolean {
        val reason = sessionEndedReason(t) ?: return false
        gate.withLock {
            if (ended) return false
            ended = true
            SessionEndedNotice.record(reason)
            try {
                endSession()
            } catch (c: CancellationException) {
                throw c
            } catch (inner: Throwable) {
                AuntieLog.e("Revoked-session sign-out failed", inner)
            }
            return true
        }
    }

    /** Test seam: forget that a teardown already ran. */
    internal suspend fun resetForTest() {
        gate.withLock { ended = false }
    }

    companion object {
        /**
         * What the shared guard does to end a session, behind one indirection so
         * a JVM unit test can drive [awaitCallable] end to end.
         *
         * Without it the only way to exercise the extension function is against
         * a real `FirebaseAuth`, which a unit test has no `FirebaseApp` for —
         * so the wiring between "a callable was refused" and "the session
         * ended" would go untested, which is the half a refactor breaks.
         */
        @Volatile
        internal var sharedEndSession: () -> Unit = { endLocalSession() }

        /**
         * The process-wide guard, used by [awaitCallable]. ONE INSTANCE BECAUSE
         * ONE FLAG: a second guard would be a second burst collapser, and two of
         * them means two sign-outs for one revocation. Same reasoning as
         * [AuthGate.shared], and constructing it touches no Firebase singleton
         * either (the lambda above is only invoked on a teardown), so naming it
         * here is safe in a Firebase-less unit test.
         */
        val shared: RevokedSessionGuard = RevokedSessionGuard { sharedEndSession() }
    }
}

/**
 * `await()` for a callable Task, and the ONLY one any callable in this app is
 * allowed to use.
 *
 * WHY AN AWAIT AND NOT A WRAPPER AROUND `getHttpsCallable`. `FirebaseFunctions`
 * and `HttpsCallableReference` are both final, so there is no object to decorate
 * the way the portal decorates its own `FunctionsClient`. What every one of the
 * hundred-odd call sites DOES share is the last link of the chain: they all end
 * in an `await()` on a `Task<HttpsCallableResult>`. Owning that link puts the
 * reaction in exactly one place without inventing a repository base class, and
 * the type makes it impossible to reach by accident from a Firestore task.
 *
 * `SessionEndedSeamTest` is what keeps it that way: it reads every file under
 * `src/main` and fails on a `getHttpsCallable` chain that still ends in a bare
 * `.await()`. A seam that anyone can forget is a hole nobody finds until an
 * operator is stuck, and one forgotten call site is enough to keep a revoked
 * admin signed in.
 *
 * Rethrows everything, always: this REACTS to the failure, it does not consume
 * it. Every caller's `runCatching { }.onFailure { AuntieLog.e(...) }` still runs
 * and its screen still says what it was going to say.
 */
suspend fun Task<HttpsCallableResult>.awaitCallable(): HttpsCallableResult {
    val result = try {
        await()
    } catch (c: CancellationException) {
        // The caller's scope went away. Not a statement about the session, and
        // swallowing it here would break every timeout above us.
        throw c
    } catch (t: Throwable) {
        RevokedSessionGuard.shared.react(t)
        throw t
    }
    RevokedSessionGuard.shared.noteSessionAlive()
    return result
}
