package com.tribetails.auntieos.web.data

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.test.runTest

/**
 * Issue #573 on the desktop admin: a refusal that means "this session is over"
 * has to end the session, and NOTHING else may.
 *
 * The four non-triggers each get their own test rather than a shared loop,
 * because each one is a different way to be wrong. Signing an operator out
 * because their wifi dropped, or because one callable was not theirs to make,
 * would be a worse bug than the one this fixes.
 *
 * These are the exact literals `functions/src/lib/sessionRevocation.ts` sends,
 * copied rather than imported: this suite cannot see the functions tree, and a
 * copy that drifts is what these assertions exist to catch.
 */
private const val SERVER_REVOKED_MESSAGE = "Your session was ended (session-revoked). Sign in again."
private const val SERVER_DISABLED_MESSAGE = "This account is turned off (user-disabled). Contact Auntie."

class SessionEndedReasonTest {

    @Test
    fun revoked_message_is_recognised() {
        assertEquals(SessionEndedReason.Revoked, sessionEndedReason(SERVER_REVOKED_MESSAGE))
    }

    @Test
    fun disabled_message_is_recognised() {
        assertEquals(SessionEndedReason.Disabled, sessionEndedReason(SERVER_DISABLED_MESSAGE))
    }

    @Test
    fun a_bare_unauthenticated_refusal_is_not_a_revocation() {
        // "Nobody is signed in" is the auth gate's business, not this seam's.
        assertNull(sessionEndedReason("Unauthenticated"))
        assertNull(sessionEndedReason("Sign in required."))
    }

    @Test
    fun a_permission_refusal_is_not_a_revocation() {
        // The session is fine; this particular call was not theirs to make.
        assertNull(sessionEndedReason("PERMISSION_DENIED: admin claim required"))
        assertNull(sessionEndedReason("Missing or insufficient permissions."))
    }

    @Test
    fun a_network_failure_is_not_a_revocation() {
        assertNull(sessionEndedReason("Connection refused"))
        assertNull(sessionEndedReason("callable 503"))
        assertNull(sessionEndedReason(null as String?))
    }

    @Test
    fun a_cancellation_is_not_a_revocation() {
        assertNull(sessionEndedReason(CancellationException("StandaloneCoroutine was cancelled")))
    }

    @Test
    fun the_reason_is_read_through_a_wrapped_cause_chain() {
        val wrapped = IllegalStateException("callable failed", RuntimeException(SERVER_REVOKED_MESSAGE))
        assertEquals(SessionEndedReason.Revoked, sessionEndedReason(wrapped))
    }

    @Test
    fun disabled_wins_over_revoked_when_both_tokens_are_present() {
        // "Your account is off" is the more specific and more actionable of the
        // two: an operator told only that their session ended goes and tries to
        // sign in again for nothing.
        assertEquals(
            SessionEndedReason.Disabled,
            sessionEndedReason("session-revoked and user-disabled"),
        )
    }

    @Test
    fun the_two_messages_say_different_things() {
        assertTrue(sessionEndedMessage(SessionEndedReason.Revoked).contains("sign in again", ignoreCase = true))
        assertTrue(sessionEndedMessage(SessionEndedReason.Disabled).contains("turned off", ignoreCase = true))
    }
}

class SessionEndedNoticeTest {

    @BeforeTest
    fun setUp() = SessionEndedNotice.clear()

    @AfterTest
    fun tearDown() = SessionEndedNotice.clear()

    @Test
    fun a_recorded_notice_is_handed_over_exactly_once() {
        SessionEndedNotice.record(SessionEndedReason.Revoked)
        assertEquals(sessionEndedMessage(SessionEndedReason.Revoked), SessionEndedNotice.consume())
        // Second read is empty, so the explanation cannot reappear on a
        // recomposition or on the operator's next visit to the sign-in screen.
        assertNull(SessionEndedNotice.consume())
    }

    @Test
    fun nothing_is_pending_when_nothing_happened() {
        assertNull(SessionEndedNotice.consume())
    }
}

class RevocationAwareCallablesTest {

    private class FakeSignOut {
        var calls = 0
            private set

        suspend fun invoke() {
            calls++
        }
    }

    @BeforeTest
    fun setUp() = SessionEndedNotice.clear()

    @AfterTest
    fun tearDown() = SessionEndedNotice.clear()

    private fun clientReturning(
        signOut: FakeSignOut,
        vararg results: WriteResult<String>,
    ): Pair<RevocationAwareCallables, MutableList<String>> {
        val seen = mutableListOf<String>()
        var i = 0
        val client = RevocationAwareCallables(
            delegate = { name, _ ->
                seen += name
                results[minOf(i++, results.size - 1)]
            },
            endSession = { signOut.invoke() },
        )
        return client to seen
    }

    @Test
    fun a_revoked_refusal_signs_the_operator_out_and_leaves_a_notice() = runTest {
        val signOut = FakeSignOut()
        val (client, _) = clientReturning(signOut, WriteResult.Err(SERVER_REVOKED_MESSAGE))

        val result = client.invoke("listTemplates", "{}")

        assertEquals(1, signOut.calls)
        assertEquals(sessionEndedMessage(SessionEndedReason.Revoked), SessionEndedNotice.consume())
        // Returned UNCHANGED. This reacts to the refusal, it does not consume it:
        // the screen that made the call still gets to say what it was going to.
        assertIs<WriteResult.Err>(result)
        assertEquals(SERVER_REVOKED_MESSAGE, result.message)
    }

    @Test
    fun a_disabled_account_signs_out_too_and_says_something_different() = runTest {
        val signOut = FakeSignOut()
        val (client, _) = clientReturning(signOut, WriteResult.Err(SERVER_DISABLED_MESSAGE))

        client.invoke("listTemplates", "{}")

        assertEquals(1, signOut.calls)
        assertEquals(sessionEndedMessage(SessionEndedReason.Disabled), SessionEndedNotice.consume())
    }

    @Test
    fun a_bare_unauthenticated_refusal_does_not_sign_anyone_out() = runTest {
        val signOut = FakeSignOut()
        val (client, _) = clientReturning(signOut, WriteResult.Err("Unauthenticated"))

        client.invoke("listTemplates", "{}")

        assertEquals(0, signOut.calls)
        assertNull(SessionEndedNotice.consume())
    }

    @Test
    fun a_permission_refusal_does_not_sign_anyone_out() = runTest {
        val signOut = FakeSignOut()
        val (client, _) = clientReturning(signOut, WriteResult.Err("PERMISSION_DENIED: not an admin"))

        client.invoke("listTemplates", "{}")

        assertEquals(0, signOut.calls)
    }

    @Test
    fun a_network_failure_does_not_sign_anyone_out() = runTest {
        val signOut = FakeSignOut()
        val (client, _) = clientReturning(signOut, WriteResult.Err("Connection refused"))

        client.invoke("listTemplates", "{}")

        assertEquals(0, signOut.calls)
    }

    @Test
    fun a_cancellation_is_rethrown_untouched_and_signs_nobody_out() = runTest {
        val signOut = FakeSignOut()
        val client = RevocationAwareCallables(
            delegate = { _, _ -> throw CancellationException("caller went away") },
            endSession = { signOut.invoke() },
        )

        // Rethrown, not swallowed: every timeout and every `withTimeout` above
        // this seam is built on cancellation propagating.
        assertFailsWith<CancellationException> { client.invoke("listTemplates", "{}") }
        assertEquals(0, signOut.calls)
    }

    @Test
    fun a_thrown_revocation_still_signs_out_and_still_rethrows() = runTest {
        val signOut = FakeSignOut()
        val client = RevocationAwareCallables(
            delegate = { _, _ -> throw IllegalStateException(SERVER_REVOKED_MESSAGE) },
            endSession = { signOut.invoke() },
        )

        assertFailsWith<IllegalStateException> { client.invoke("listTemplates", "{}") }
        assertEquals(1, signOut.calls)
    }

    @Test
    fun a_burst_of_refusals_signs_out_once() = runTest {
        val signOut = FakeSignOut()
        val gate = CompletableDeferred<Unit>()
        val client = RevocationAwareCallables(
            delegate = { _, _ ->
                gate.await()
                WriteResult.Err(SERVER_REVOKED_MESSAGE)
            },
            endSession = { signOut.invoke() },
        )

        // A screen that loads fires several callables at once and every one comes
        // back refused. Six sign-outs racing six auth-state emissions is not a
        // thing anyone wants to debug.
        val inFlight = (1..6).map { async { client.invoke("listTemplates", "{}") } }
        gate.complete(Unit)
        inFlight.awaitAll()

        assertEquals(1, signOut.calls)
    }

    @Test
    fun a_success_re_arms_the_guard_so_a_second_revocation_is_not_ignored() = runTest {
        val signOut = FakeSignOut()
        val (client, _) = clientReturning(
            signOut,
            WriteResult.Err(SERVER_REVOKED_MESSAGE),
            WriteResult.Ok("{}"),
            WriteResult.Err(SERVER_REVOKED_MESSAGE),
        )

        client.invoke("a", "{}")
        assertEquals(1, signOut.calls)

        // The desktop app runs for days. Without the re-arm the guard is a
        // once-per-process latch, and a SECOND revocation weeks later -- a
        // password change, a sign-out on another device -- is silently ignored,
        // leaving the operator looping on refused calls. The React admin hides
        // the same shape behind a document navigation; there is none here.
        client.invoke("b", "{}") // succeeds
        client.invoke("c", "{}") // refused again
        assertEquals(2, signOut.calls)
    }

    @Test
    fun an_ordinary_success_is_passed_straight_through() = runTest {
        val signOut = FakeSignOut()
        val (client, seen) = clientReturning(signOut, WriteResult.Ok("""{"ok":true}"""))

        val result = client.invoke("listTemplates", """{"a":1}""")

        assertEquals(listOf("listTemplates"), seen)
        assertIs<WriteResult.Ok<String>>(result)
        assertEquals("""{"ok":true}""", result.value)
        assertEquals(0, signOut.calls)
        assertNull(SessionEndedNotice.consume())
    }

    @Test
    fun a_failing_sign_out_does_not_take_the_caller_down_with_it() = runTest {
        val client = RevocationAwareCallables(
            delegate = { _, _ -> WriteResult.Err(SERVER_REVOKED_MESSAGE) },
            endSession = { throw IllegalStateException("no network for sign-out") },
        )

        // The refusal still has to reach the caller. A sign-out that could not
        // complete is not a reason to turn one failed call into two.
        val result = client.invoke("listTemplates", "{}")
        assertIs<WriteResult.Err>(result)
        assertEquals(sessionEndedMessage(SessionEndedReason.Revoked), SessionEndedNotice.consume())
    }
}
