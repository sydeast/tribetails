package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctionsException
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.every
import io.mockk.mockk
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Issue #573 on the Android admin: a refusal that means "this session is over"
 * has to end the session, and NOTHING else may.
 *
 * The four non-triggers each get their own test rather than sharing a loop,
 * because each is a different way to be wrong, and getting any of them wrong is
 * a worse bug than the one this fixes: signing an operator out because their
 * wifi dropped, or because one callable was not theirs to make, would take a
 * working console away mid-visit.
 *
 * The server literals below are copied rather than imported. This suite cannot
 * see the functions tree, and a copy that drifts from
 * `functions/src/lib/sessionRevocation.ts` is exactly what these assertions
 * exist to catch — the whole reaction goes deaf if the tokens stop matching.
 */
private const val SERVER_REVOKED_MESSAGE = "Your session was ended (session-revoked). Sign in again."
private const val SERVER_DISABLED_MESSAGE = "This account is turned off (user-disabled). Contact Auntie."

/**
 * A callable refusal exactly as the Android SDK delivers one.
 *
 * Mocked rather than constructed: `FirebaseFunctionsException`'s constructor is
 * internal to the SDK, and `VoiceTokenManagerTest` already builds its refusals
 * this way for the same reason. `cause` is stubbed null so the classifier's
 * cause walk terminates.
 */
private fun refusal(
    code: FirebaseFunctionsException.Code,
    message: String,
    details: Any? = null,
): FirebaseFunctionsException {
    val err = mockk<FirebaseFunctionsException>()
    every { err.code } returns code
    every { err.message } returns message
    every { err.details } returns details
    every { err.cause } returns null
    return err
}
class SessionEndedReasonTest {

    @Test
    fun `it reads the reason off the callable details payload`() {
        // The clean channel, when the Android SDK hands one through.
        val err = refusal(
            FirebaseFunctionsException.Code.UNAUTHENTICATED,
            "refused",
            mapOf("reason" to "session-revoked"),
        )
        assertEquals(SessionEndedReason.Revoked, sessionEndedReason(err))
    }

    @Test
    fun `it falls back to the message token when details did not survive the trip`() {
        val err = refusal(FirebaseFunctionsException.Code.UNAUTHENTICATED, SERVER_REVOKED_MESSAGE)
        assertEquals(SessionEndedReason.Revoked, sessionEndedReason(err))
    }

    @Test
    fun `it recognises a disabled account`() {
        val err = refusal(FirebaseFunctionsException.Code.UNAUTHENTICATED, SERVER_DISABLED_MESSAGE)
        assertEquals(SessionEndedReason.Disabled, sessionEndedReason(err))
    }

    @Test
    fun `a bare unauthenticated refusal is not a revocation`() {
        // "Nobody is signed in" is the sign-in screen's business, not this seam's.
        assertNull(sessionEndedReason(refusal(FirebaseFunctionsException.Code.UNAUTHENTICATED, "Unauthenticated")))
        assertNull(sessionEndedReason(IllegalStateException(AuthGate.SIGN_IN_REQUIRED)))
    }

    @Test
    fun `a permission refusal is not a revocation`() {
        // The session is fine; this particular call was not theirs to make, and
        // VoiceTokenManager already depends on that distinction holding.
        assertNull(
            sessionEndedReason(
                refusal(FirebaseFunctionsException.Code.PERMISSION_DENIED, "admin claim required"),
            ),
        )
    }

    @Test
    fun `a network failure or a deadline is not a revocation`() {
        assertNull(sessionEndedReason(java.io.IOException("Unable to resolve host")))
        assertNull(
            sessionEndedReason(
                refusal(FirebaseFunctionsException.Code.DEADLINE_EXCEEDED, "deadline exceeded"),
            ),
        )
    }

    @Test
    fun `a cancellation is not a revocation`() {
        assertNull(sessionEndedReason(CancellationException("StandaloneCoroutine was cancelled")))
        assertNull(sessionEndedReason(null))
    }

    @Test
    fun `the reason is read through a wrapped cause chain`() {
        // Everything on the way here wraps the original at least once.
        val wrapped = IllegalStateException(
            "listTemplates failed",
            RuntimeException(SERVER_REVOKED_MESSAGE),
        )
        assertEquals(SessionEndedReason.Revoked, sessionEndedReason(wrapped))
    }

    @Test
    fun `disabled wins over revoked when both tokens are present`() {
        // The more specific and more actionable of the two: an operator told
        // only that their session ended goes and tries to sign in for nothing.
        assertEquals(
            SessionEndedReason.Disabled,
            sessionEndedReason(RuntimeException("session-revoked and user-disabled")),
        )
    }

    @Test
    fun `the two messages say different things`() {
        assertTrue(sessionEndedMessage(SessionEndedReason.Revoked).contains("sign in again", ignoreCase = true))
        assertTrue(sessionEndedMessage(SessionEndedReason.Disabled).contains("turned off", ignoreCase = true))
    }
}

class SessionEndedNoticeTest {

    @Before fun setUp() = SessionEndedNotice.clear()

    @After fun tearDown() = SessionEndedNotice.clear()

    @Test
    fun `a recorded notice is handed over exactly once`() {
        SessionEndedNotice.record(SessionEndedReason.Revoked)
        assertEquals(sessionEndedMessage(SessionEndedReason.Revoked), SessionEndedNotice.consume())
        // Second read is empty, so the explanation cannot reappear on a
        // recomposition or on the operator's next visit to the login screen.
        assertNull(SessionEndedNotice.consume())
    }

    @Test
    fun `nothing is pending when nothing happened`() {
        assertNull(SessionEndedNotice.consume())
    }
}

class EndLocalSessionTest {

    @Test
    fun `it signs Firebase out AND drops the cached claim`() {
        // The two steps are one step. Signing out while leaving the claim cache
        // populated keeps the finished session's sandbox scope live for whoever
        // signs in next, and that scope decides which business's records a query
        // may see. This has already been a real leak once.
        val auth = mockk<com.google.firebase.auth.FirebaseAuth>(relaxed = true)
        val gate = mockk<AuthGate>(relaxed = true)

        endLocalSession(auth, gate)

        io.mockk.verify(exactly = 1) { auth.signOut() }
        io.mockk.verify(exactly = 1) { gate.clearTestModeCache() }
    }
}

class RevokedSessionGuardTest {

    private class FakeSignOut : () -> Unit {
        var calls = 0
            private set

        override fun invoke() {
            calls++
        }
    }

    @Before fun setUp() = SessionEndedNotice.clear()

    @After fun tearDown() = SessionEndedNotice.clear()

    @Test
    fun `a revoked refusal signs the operator out and leaves a notice`() = runBlocking {
        val signOut = FakeSignOut()
        val guard = RevokedSessionGuard(signOut)

        assertTrue(guard.react(RuntimeException(SERVER_REVOKED_MESSAGE)))

        assertEquals(1, signOut.calls)
        assertEquals(sessionEndedMessage(SessionEndedReason.Revoked), SessionEndedNotice.consume())
    }

    @Test
    fun `a disabled account signs out too, and says something different`() = runBlocking {
        val signOut = FakeSignOut()
        val guard = RevokedSessionGuard(signOut)

        guard.react(RuntimeException(SERVER_DISABLED_MESSAGE))

        assertEquals(1, signOut.calls)
        assertEquals(sessionEndedMessage(SessionEndedReason.Disabled), SessionEndedNotice.consume())
    }

    @Test
    fun `none of the four non-triggers signs anyone out`() = runBlocking {
        val signOut = FakeSignOut()
        val guard = RevokedSessionGuard(signOut)

        assertFalse(guard.react(refusal(FirebaseFunctionsException.Code.UNAUTHENTICATED, "Unauthenticated")))
        assertFalse(guard.react(refusal(FirebaseFunctionsException.Code.PERMISSION_DENIED, "nope")))
        assertFalse(guard.react(java.io.IOException("Unable to resolve host")))
        assertFalse(guard.react(CancellationException("cancelled")))

        assertEquals(0, signOut.calls)
        assertNull(SessionEndedNotice.consume())
    }

    @Test
    fun `a burst of refusals signs out once`() = runBlocking {
        val signOut = FakeSignOut()
        val guard = RevokedSessionGuard(signOut)
        val gate = CompletableDeferred<Unit>()

        // A screen that loads fires several callables at once and every one comes
        // back refused. Six sign-outs racing six AuthStateListener emissions is
        // not a thing anyone wants to debug.
        val inFlight = (1..6).map {
            async {
                gate.await()
                guard.react(RuntimeException(SERVER_REVOKED_MESSAGE))
            }
        }
        gate.complete(Unit)
        val tookAction = inFlight.awaitAll()

        assertEquals(1, signOut.calls)
        assertEquals(1, tookAction.count { it })
    }

    @Test
    fun `a success re-arms the guard, so a SECOND revocation is not ignored`() = runBlocking {
        val signOut = FakeSignOut()
        val guard = RevokedSessionGuard(signOut)

        guard.react(RuntimeException(SERVER_REVOKED_MESSAGE))
        assertEquals(1, signOut.calls)

        // Still latched: the burst is still the same burst.
        guard.react(RuntimeException(SERVER_REVOKED_MESSAGE))
        assertEquals(1, signOut.calls)

        // An Android process outlives many sessions. Without this re-arm the
        // flag is a once-per-process latch and a revocation weeks later -- a
        // password change, a sign-out on another device -- is silently ignored,
        // leaving the operator looping on refused calls.
        guard.noteSessionAlive()
        guard.react(RuntimeException(SERVER_REVOKED_MESSAGE))
        assertEquals(2, signOut.calls)
    }

    @Test
    fun `a failing sign-out is swallowed rather than thrown at the caller`() = runBlocking {
        val guard = RevokedSessionGuard { throw IllegalStateException("no network for sign-out") }

        // The refusal still has to reach the caller's own error handling. A
        // sign-out that could not complete is not a reason to turn one failed
        // call into two.
        assertTrue(guard.react(RuntimeException(SERVER_REVOKED_MESSAGE)))
        assertEquals(sessionEndedMessage(SessionEndedReason.Revoked), SessionEndedNotice.consume())
    }
}

/**
 * The seam itself, driven end to end: `awaitCallable()` is what every one of the
 * app's callable chains ends in, so this is the wiring a refactor breaks.
 */
class AwaitCallableTest {

    private var signOutCount = 0

    @Before
    fun setUp() = runBlocking {
        SessionEndedNotice.clear()
        signOutCount = 0
        RevokedSessionGuard.sharedEndSession = { signOutCount++ }
        RevokedSessionGuard.shared.resetForTest()
    }

    @After
    fun tearDown() {
        SessionEndedNotice.clear()
        RevokedSessionGuard.sharedEndSession = { endLocalSession() }
    }

    @Test
    fun `a successful callable is passed straight through`() = runBlocking {
        val result = mockk<HttpsCallableResult>(relaxed = true)

        assertSame(result, Tasks.forResult(result).awaitCallable())

        assertEquals(0, signOutCount)
        assertNull(SessionEndedNotice.consume())
    }

    @Test
    fun `a revoked refusal signs out and STILL rethrows`() = runBlocking {
        val refused = refusal(FirebaseFunctionsException.Code.UNAUTHENTICATED, SERVER_REVOKED_MESSAGE)

        val thrown = runCatching {
            Tasks.forException<HttpsCallableResult>(refused).awaitCallable()
        }.exceptionOrNull()

        // Rethrown, not consumed: every caller's `runCatching { }.onFailure { }`
        // still runs and its screen still says what it was going to say.
        assertTrue(thrown is FirebaseFunctionsException)
        assertEquals(1, signOutCount)
        assertEquals(sessionEndedMessage(SessionEndedReason.Revoked), SessionEndedNotice.consume())
    }

    @Test
    fun `an ordinary refusal rethrows and signs nobody out`() = runBlocking {
        val refused = refusal(FirebaseFunctionsException.Code.PERMISSION_DENIED, "not your data")

        val thrown = runCatching {
            Tasks.forException<HttpsCallableResult>(refused).awaitCallable()
        }.exceptionOrNull()

        assertTrue(thrown is FirebaseFunctionsException)
        assertEquals(0, signOutCount)
        assertNull(SessionEndedNotice.consume())
    }
}
