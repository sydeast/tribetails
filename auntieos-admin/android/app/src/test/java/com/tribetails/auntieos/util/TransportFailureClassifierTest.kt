package com.tribetails.auntieos.util

import com.google.firebase.functions.FirebaseFunctionsException
import io.mockk.every
import io.mockk.mockk
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AUNTIEOS-ADMIN-19: `us-central1-auntieos-ttpc.cloudfunctions.net` timing out
 * or failing DNS on an offline device was reported to Sentry as an `INTERNAL`
 * [FirebaseFunctionsException], once per failed read, for as long as the
 * device stayed offline (the real Sentry event chains
 * `UnknownHostException` -> `SocketTimeoutException` -> `SocketException`
 * under a top-level `FirebaseFunctionsException: INTERNAL`). [isTransportFailure]
 * is the line between "the network dropped this call" and "the server actually
 * threw", pinned here so a bare `INTERNAL` — a real server-side failure — is
 * never silently swallowed alongside it.
 *
 * AUNTIEOS-ADMIN-W: an AOSP emulator with no Play Services fails FCM token
 * fetch with a plain `IOException("MISSING_INSTANCEID_SERVICE")`, and
 * `GmsRpc` reports the sibling condition as `IOException("SERVICE_NOT_AVAILABLE")`.
 * [isFcmUnavailable] is what MainActivity/VoiceTokenManager check before
 * reporting that failure to Sentry.
 */
class TransportFailureClassifierTest {

    // ── isTransportFailure ──────────────────────────────────────────────

    @Test
    fun `null is never a transport failure`() {
        assertFalse(isTransportFailure(null))
    }

    @Test
    fun `UnknownHostException is a transport failure`() {
        assertTrue(isTransportFailure(UnknownHostException("Unable to resolve host")))
    }

    @Test
    fun `SocketTimeoutException is a transport failure`() {
        assertTrue(isTransportFailure(SocketTimeoutException("failed to connect")))
    }

    @Test
    fun `ConnectException is a transport failure`() {
        assertTrue(isTransportFailure(ConnectException("Connection refused")))
    }

    @Test
    fun `an unrelated exception is not a transport failure`() {
        assertFalse(isTransportFailure(IllegalStateException("something else broke")))
    }

    @Test
    fun `FirebaseFunctionsException UNAVAILABLE is a transport failure even with no cause`() {
        val error = mockk<FirebaseFunctionsException>()
        every { error.code } returns FirebaseFunctionsException.Code.UNAVAILABLE
        every { error.cause } returns null

        assertTrue(isTransportFailure(error))
    }

    @Test
    fun `FirebaseFunctionsException INTERNAL wrapping UnknownHostException is a transport failure`() {
        val error = mockk<FirebaseFunctionsException>()
        every { error.code } returns FirebaseFunctionsException.Code.INTERNAL
        every { error.cause } returns UnknownHostException("Unable to resolve host")

        assertTrue(isTransportFailure(error))
    }

    @Test
    fun `FirebaseFunctionsException INTERNAL wrapping SocketTimeoutException is a transport failure`() {
        val error = mockk<FirebaseFunctionsException>()
        every { error.code } returns FirebaseFunctionsException.Code.INTERNAL
        every { error.cause } returns SocketTimeoutException("timeout")

        assertTrue(isTransportFailure(error))
    }

    @Test
    fun `FirebaseFunctionsException DEADLINE_EXCEEDED wrapping SocketTimeoutException is a transport failure`() {
        // FirebaseFunctions' own onFailure handler maps an InterruptedIOException
        // (SocketTimeoutException's parent) to DEADLINE_EXCEEDED, not INTERNAL --
        // a pure connect/read timeout with no DNS failure first never reaches the
        // INTERNAL branch at all.
        val error = mockk<FirebaseFunctionsException>()
        every { error.code } returns FirebaseFunctionsException.Code.DEADLINE_EXCEEDED
        every { error.cause } returns SocketTimeoutException("timeout")

        assertTrue(isTransportFailure(error))
    }

    @Test
    fun `a bare FirebaseFunctionsException DEADLINE_EXCEEDED with no IOException cause is a real failure`() {
        val error = mockk<FirebaseFunctionsException>()
        every { error.code } returns FirebaseFunctionsException.Code.DEADLINE_EXCEEDED
        every { error.cause } returns null

        assertFalse(isTransportFailure(error))
    }

    @Test
    fun `a bare FirebaseFunctionsException INTERNAL with no IOException cause is a real failure`() {
        // The server itself throwing (a bug, a bad callable) also surfaces as
        // INTERNAL. Without a network-shaped cause, this must stay reported.
        val error = mockk<FirebaseFunctionsException>()
        every { error.code } returns FirebaseFunctionsException.Code.INTERNAL
        every { error.cause } returns null

        assertFalse(isTransportFailure(error))
    }

    @Test
    fun `FirebaseFunctionsException FAILED_PRECONDITION is never a transport failure`() {
        // e.g. a misconfigured Twilio secret (see VoiceTokenManager) -- a real
        // defect that must keep reaching Sentry.
        val error = mockk<FirebaseFunctionsException>()
        every { error.code } returns FirebaseFunctionsException.Code.FAILED_PRECONDITION
        every { error.cause } returns IOException("irrelevant")

        assertFalse(isTransportFailure(error))
    }

    // ── isFcmUnavailable ────────────────────────────────────────────────

    @Test
    fun `null is never an fcm-unavailable failure`() {
        assertFalse(isFcmUnavailable(null))
    }

    @Test
    fun `MISSING_INSTANCEID_SERVICE is fcm-unavailable`() {
        assertTrue(isFcmUnavailable(IOException("MISSING_INSTANCEID_SERVICE")))
    }

    @Test
    fun `SERVICE_NOT_AVAILABLE is fcm-unavailable`() {
        assertTrue(isFcmUnavailable(IOException("SERVICE_NOT_AVAILABLE")))
    }

    @Test
    fun `an unrelated IOException is not fcm-unavailable`() {
        assertFalse(isFcmUnavailable(IOException("Connection reset")))
    }

    @Test
    fun `a non-IOException is never fcm-unavailable even with a matching message`() {
        assertFalse(isFcmUnavailable(RuntimeException("MISSING_INSTANCEID_SERVICE")))
    }

    @Test
    fun `an IOException with no message is not fcm-unavailable`() {
        assertFalse(isFcmUnavailable(IOException()))
    }
}
