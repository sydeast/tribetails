package com.tribetails.auntieos.util

import io.sentry.SentryEvent
import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * #1067 (AUNTIEOS-ADMIN-1X, AUNTIEOS-ADMIN-1Z): Compose throws
 * `LeftCompositionCancellationException` / `ForgottenCoroutineScopeException`
 * when a `LaunchedEffect` or `rememberCoroutineScope` scope leaves composition.
 * Both are plain [CancellationException] subclasses: a coroutine being told to
 * stop, not a defect. These pin the classifier the Sentry guard is built on.
 */
class CancellationGuardTest {

    /** Stand-in for Compose's internal LeftCompositionCancellationException. */
    private class LeftCompositionCancellation : CancellationException("The coroutine scope left the composition")

    @Test
    fun `null is not a cancellation`() {
        assertFalse(isCancellation(null))
    }

    @Test
    fun `a plain exception is not a cancellation`() {
        assertFalse(isCancellation(IllegalStateException("boom")))
    }

    @Test
    fun `a CancellationException is a cancellation`() {
        assertTrue(isCancellation(CancellationException("stop")))
    }

    @Test
    fun `a CancellationException subclass is a cancellation`() {
        assertTrue(isCancellation(LeftCompositionCancellation()))
    }

    @Test
    fun `a cancellation chained as the cause is a cancellation`() {
        val wrapped = RuntimeException("load failed", LeftCompositionCancellation())
        assertTrue(isCancellation(wrapped))
    }

    @Test
    fun `a cancellation deep in the cause chain is a cancellation`() {
        val wrapped = RuntimeException("a", IllegalStateException("b", RuntimeException("c", CancellationException("d"))))
        assertTrue(isCancellation(wrapped))
    }

    @Test
    fun `a cause chain that loops terminates`() {
        val a = RuntimeException("a")
        val b = RuntimeException("b", a)
        a.initCause(b)
        assertFalse(isCancellation(a))
    }

    @Test
    fun `beforeSend drops an event carrying a cancellation`() {
        assertNull(filterCancellationEvent(SentryEvent(LeftCompositionCancellation())))
    }

    @Test
    fun `beforeSend drops an event whose throwable chains a cancellation`() {
        val event = SentryEvent(RuntimeException("wrapped", CancellationException("stop")))
        assertNull(filterCancellationEvent(event))
    }

    @Test
    fun `beforeSend keeps an event for a real exception`() {
        val event = SentryEvent(IllegalStateException("real defect"))
        assertSame(event, filterCancellationEvent(event))
    }

    @Test
    fun `beforeSend keeps a message event with no throwable`() {
        val event = SentryEvent()
        assertSame(event, filterCancellationEvent(event))
    }

    @Test
    fun `rethrowIfCancellation rethrows a cancellation`() {
        val cancelled = LeftCompositionCancellation()
        try {
            cancelled.rethrowIfCancellation()
            fail("expected the cancellation to be rethrown")
        } catch (e: CancellationException) {
            assertSame(cancelled, e)
        }
    }

    @Test
    fun `rethrowIfCancellation leaves a real exception alone`() {
        IllegalStateException("real").rethrowIfCancellation()
        // A wrapper whose cause is a cancellation is not itself one: rethrowing
        // it would surface a RuntimeException where a quiet cancel belongs.
        RuntimeException("wrapped", CancellationException("stop")).rethrowIfCancellation()
    }

    @Test
    fun `runCatchingCancellable rethrows cancellation and captures the rest`() {
        try {
            runCatchingCancellable<Unit> { throw CancellationException("stop") }
            fail("expected the cancellation to be rethrown")
        } catch (_: CancellationException) {
        }
        val failure = runCatchingCancellable<Unit> { throw IllegalStateException("real") }
        assertEquals("real", failure.exceptionOrNull()?.message)
        assertEquals(3, runCatchingCancellable { 3 }.getOrNull())
    }
}
