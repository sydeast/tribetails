package com.tribetails.auntieos.session

import com.google.firebase.FirebaseNetworkException
import com.google.firebase.auth.FirebaseAuthInvalidUserException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.UnknownHostException

/**
 * #454. The pure half: which failures are worth waiting out, how long the waits
 * grow, and what the operator actually reads. No Firebase, no coroutines.
 */
class SessionHealthTest {

    @Test
    fun `a refused connection is worth retrying`() {
        assertTrue(isRetryableRefreshFailure(FirebaseNetworkException("Failed to fetch")))
        assertTrue(isRetryableRefreshFailure(UnknownHostException("securetoken.googleapis.com")))
        assertTrue(isRetryableRefreshFailure(IOException("stream closed")))
    }

    @Test
    fun `a network failure wrapped by a caller is still a network failure`() {
        val wrapped = IllegalStateException("could not read claim", FirebaseNetworkException("no route"))
        assertTrue(isRetryableRefreshFailure(wrapped))
    }

    @Test
    fun `a cycle in the cause chain does not hang the classifier`() {
        val a = IllegalStateException("a")
        val b = IllegalStateException("b", a)
        a.initCause(b)
        assertFalse(isRetryableRefreshFailure(b))
    }

    @Test
    fun `a session the server has invalidated is not worth retrying`() {
        assertFalse(isRetryableRefreshFailure(FirebaseAuthInvalidUserException("USER_DISABLED", "disabled")))
        assertFalse(isRetryableRefreshFailure(IllegalStateException("no token")))
    }

    @Test
    fun `the retry gap doubles from the floor and stops at the ceiling`() {
        assertEquals(SESSION_RETRY_MIN_MILLIS, sessionRetryDelayMillis(1))
        assertEquals(SESSION_RETRY_MIN_MILLIS * 2, sessionRetryDelayMillis(2))
        assertEquals(SESSION_RETRY_MIN_MILLIS * 4, sessionRetryDelayMillis(3))
        assertEquals(SESSION_RETRY_MAX_MILLIS, sessionRetryDelayMillis(20))
        // A long outage must not overflow its way back down to a tight loop.
        assertEquals(SESSION_RETRY_MAX_MILLIS, sessionRetryDelayMillis(9_999))
    }

    @Test
    fun `the retry gap never drops below the floor`() {
        assertEquals(SESSION_RETRY_MIN_MILLIS, sessionRetryDelayMillis(0))
        assertEquals(SESSION_RETRY_MIN_MILLIS, sessionRetryDelayMillis(-3))
    }

    @Test
    fun `a healthy session has nothing to say`() {
        assertNull(sessionHealthNotice(SessionHealth.Ok))
    }

    @Test
    fun `a refused renewal names the consequence and offers no sign-in yet`() {
        val notice = sessionHealthNotice(SessionHealth.Unreachable(failures = 3))!!
        assertFalse(notice.reauth)
        // The point of the copy: an operator has to be able to connect an
        // unexplained refusal back to this.
        assertTrue(notice.detail.contains("turned down"))
    }

    @Test
    fun `a session that cannot renew asks for a fresh sign-in`() {
        val notice = sessionHealthNotice(SessionHealth.Expired)!!
        assertTrue(notice.reauth)
    }

    @Test
    fun `the two degraded states do not read the same`() {
        val unreachable = sessionHealthNotice(SessionHealth.Unreachable(failures = 1))!!
        val expired = sessionHealthNotice(SessionHealth.Expired)!!
        assertNotEquals(unreachable.title, expired.title)
        assertNotEquals(unreachable.detail, expired.detail)
    }

    @Test
    fun `the copy matches the web admin's, so an operator reads one app`() {
        // auntieos-admin/src/components/SessionBanner.tsx holds the same two
        // titles. They are asserted here rather than merely commented because
        // "mirrors the web" is not a claim a reader can check by reading.
        assertEquals(
            "Signed in, but out of touch",
            sessionHealthNotice(SessionHealth.Unreachable(failures = 1))!!.title,
        )
        assertEquals(
            "Sign in again to keep working",
            sessionHealthNotice(SessionHealth.Expired)!!.title,
        )
    }
}
