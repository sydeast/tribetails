package com.kinfolk.portal.auth

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #557. The classifier is the whole three-way distinction on this client: only
 * a refusal the backend TAGGED ends the session. Everything else — not signed
 * in, permission-denied, a network failure — keeps the behavior it had, because
 * signing somebody out over bad wifi is a worse bug than the one being fixed.
 */
class SessionEndedTest {

    @AfterTest
    fun tearDown() {
        SessionEndedNotice.clear()
    }

    @Test
    fun revoked_session_is_recognised() {
        val t = RuntimeException("Your session was ended (session-revoked). Sign in again.")
        assertEquals(SessionEndedReason.Revoked, sessionEndedReason(t))
    }

    @Test
    fun disabled_account_is_recognised() {
        val t = RuntimeException("This account is turned off (user-disabled). Contact Auntie.")
        assertEquals(SessionEndedReason.Disabled, sessionEndedReason(t))
    }

    @Test
    fun reason_is_found_through_a_wrapping_exception() {
        // Every client on the way here wraps at least once: the native SDK
        // wraps the wire error, gitlive wraps that again.
        val wrapped = IllegalStateException(
            "call getMyHome failed",
            RuntimeException("Your session was ended (session-revoked). Sign in again."),
        )
        assertEquals(SessionEndedReason.Revoked, sessionEndedReason(wrapped))
    }

    @Test
    fun plain_unauthenticated_is_not_a_revoked_session() {
        assertNull(sessionEndedReason(RuntimeException("unauthenticated: Sign in required.")))
    }

    @Test
    fun permission_denied_is_not_a_revoked_session() {
        assertNull(sessionEndedReason(RuntimeException("permission-denied: not your family")))
    }

    @Test
    fun a_network_failure_is_not_a_revoked_session() {
        assertNull(sessionEndedReason(RuntimeException("Failed to fetch")))
        assertNull(sessionEndedReason(null))
    }

    @Test
    fun a_cause_cycle_does_not_hang_the_classifier() {
        // Defensive: some SDKs hand back an exception whose cause is itself.
        val selfCaused = object : RuntimeException("boom") {
            override val cause: Throwable get() = this
        }
        assertNull(sessionEndedReason(selfCaused))
    }

    @Test
    fun notice_is_recorded_once_and_consumed_once() {
        SessionEndedNotice.record(SessionEndedReason.Revoked)
        val first = SessionEndedNotice.consume()
        assertTrue(first!!.contains("sign in again", ignoreCase = true))
        assertNull(SessionEndedNotice.consume())
    }

    @Test
    fun a_disabled_account_gets_different_copy_from_a_revoked_session() {
        assertTrue(sessionEndedMessage(SessionEndedReason.Disabled).contains("turned off"))
        assertTrue(sessionEndedMessage(SessionEndedReason.Revoked).contains("session ended"))
    }
}
