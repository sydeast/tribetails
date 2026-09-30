package com.tribetails.auntieos.util

import io.sentry.SentryEvent
import io.sentry.protocol.SentryException
import java.net.UnknownHostException
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.delay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * #1067 / AUNTIEOS-ADMIN-1X / AUNTIEOS-ADMIN-1Z: Compose's
 * `LeftCompositionCancellationException` and `ForgottenCoroutineScopeException`
 * (both [CancellationException]s) were caught by repository `runCatching`
 * blocks and reported to Sentry through [AuntieLog]. Pins that the reporting
 * helper and the `beforeSend` filter drop cancellation, direct or nested, and
 * still report ordinary failures.
 */
class CancellationFilterTest {

    /** Stand-ins with the real Compose class names (those are internal to Compose). */
    private class LeftCompositionCancellationException : CancellationException("The coroutine scope left the composition")
    private class ForgottenCoroutineScopeException : CancellationException("rememberCoroutineScope left the composition")

    private fun timeout(): TimeoutCancellationException = try {
        runBlocking { withTimeout(1) { delay(1_000) } }
        error("withTimeout did not time out")
    } catch (t: TimeoutCancellationException) {
        t
    }

    // ── isCoroutineCancellation ─────────────────────────────────────────

    @Test
    fun `null is not cancellation`() {
        assertFalse(isCoroutineCancellation(null))
    }

    @Test
    fun `a direct CancellationException is cancellation`() {
        assertTrue(isCoroutineCancellation(CancellationException("cancelled")))
        assertTrue(isCoroutineCancellation(LeftCompositionCancellationException()))
        assertTrue(isCoroutineCancellation(ForgottenCoroutineScopeException()))
    }

    @Test
    fun `a CancellationException nested as a cause is cancellation`() {
        val wrapped = IllegalStateException("outer", RuntimeException("middle", ForgottenCoroutineScopeException()))
        assertTrue(isCoroutineCancellation(wrapped))
    }

    @Test
    fun `an ordinary exception is not cancellation`() {
        assertFalse(isCoroutineCancellation(IllegalStateException("real bug", RuntimeException("cause"))))
    }

    @Test
    fun `a withTimeout expiry is a real failure, not cancellation`() {
        assertFalse(isCoroutineCancellation(timeout()))
    }

    @Test
    fun `a cyclic cause chain terminates`() {
        val a = RuntimeException("a")
        val b = RuntimeException("b", a)
        a.initCause(b)
        assertFalse(isCoroutineCancellation(a))
    }

    // ── AuntieLog reporting decision ────────────────────────────────────

    @Test
    fun `AuntieLog drops direct cancellation`() {
        assertEquals(AuntieLog.Disposition.DROP, AuntieLog.dispositionFor(LeftCompositionCancellationException()))
    }

    @Test
    fun `AuntieLog drops nested cancellation`() {
        assertEquals(
            AuntieLog.Disposition.DROP,
            AuntieLog.dispositionFor(RuntimeException("wrapped", ForgottenCoroutineScopeException())),
        )
    }

    @Test
    fun `AuntieLog still reports ordinary exceptions`() {
        assertEquals(AuntieLog.Disposition.EXCEPTION, AuntieLog.dispositionFor(IllegalStateException("real bug")))
    }

    @Test
    fun `AuntieLog still reports a withTimeout expiry`() {
        assertEquals(AuntieLog.Disposition.EXCEPTION, AuntieLog.dispositionFor(timeout()))
    }

    @Test
    fun `AuntieLog keeps transport failures as breadcrumbs and messages as messages`() {
        assertEquals(AuntieLog.Disposition.BREADCRUMB, AuntieLog.dispositionFor(UnknownHostException("offline")))
        assertEquals(AuntieLog.Disposition.MESSAGE, AuntieLog.dispositionFor(null))
    }

    @Test
    fun `AuntieLog e and w return quietly for cancellation`() {
        AuntieLog.e("load cancelled", LeftCompositionCancellationException())
        AuntieLog.w("load cancelled", RuntimeException("wrapped", ForgottenCoroutineScopeException()))
    }

    // ── Sentry beforeSend filter ────────────────────────────────────────

    @Test
    fun `beforeSend drops an event whose throwable is cancellation`() {
        assertNull(dropCancellationEvent(SentryEvent(LeftCompositionCancellationException())))
    }

    @Test
    fun `beforeSend drops an event whose throwable wraps cancellation`() {
        assertNull(dropCancellationEvent(SentryEvent(RuntimeException("x", ForgottenCoroutineScopeException()))))
    }

    @Test
    fun `beforeSend drops a chained event identified only by exception type`() {
        for (type in listOf("LeftCompositionCancellationException", "ForgottenCoroutineScopeException", "JobCancellationException")) {
            val event = SentryEvent().apply {
                exceptions = listOf(SentryException().apply { this.type = type })
            }
            assertNull(type, dropCancellationEvent(event))
        }
    }

    @Test
    fun `beforeSend keeps ordinary events`() {
        val event = SentryEvent(IllegalStateException("real bug"))
        assertSame(event, dropCancellationEvent(event))
        val byType = SentryEvent().apply {
            exceptions = listOf(SentryException().apply { type = "IllegalStateException" })
        }
        assertSame(byType, dropCancellationEvent(byType))
        val timeoutByType = SentryEvent().apply {
            exceptions = listOf(SentryException().apply { type = "TimeoutCancellationException" })
        }
        assertSame(timeoutByType, dropCancellationEvent(timeoutByType))
        val message = SentryEvent()
        assertSame(message, dropCancellationEvent(message))
    }

    // ── Result.rethrowCancellation ──────────────────────────────────────

    @Test
    fun `rethrowCancellation rethrows a cancelled Result`() {
        val cancelled = LeftCompositionCancellationException()
        try {
            Result.failure<Unit>(cancelled).rethrowCancellation()
            fail("expected cancellation to be rethrown")
        } catch (e: CancellationException) {
            assertSame(cancelled, e)
        }
    }

    @Test
    fun `rethrowCancellation rethrows a nested cancellation as CancellationException`() {
        val wrapped = RuntimeException("x", ForgottenCoroutineScopeException())
        try {
            Result.failure<Unit>(wrapped).rethrowCancellation()
            fail("expected cancellation to be rethrown")
        } catch (e: CancellationException) {
            assertSame(wrapped, e.cause)
        }
    }

    @Test
    fun `rethrowCancellation passes ordinary results through`() {
        val ok = Result.success(1)
        assertEquals(ok, ok.rethrowCancellation())
        val bad = Result.failure<Int>(IllegalStateException("real"))
        assertEquals(bad, bad.rethrowCancellation())
    }
}
