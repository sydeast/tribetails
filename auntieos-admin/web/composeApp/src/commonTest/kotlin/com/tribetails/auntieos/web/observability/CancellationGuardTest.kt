package com.tribetails.auntieos.web.observability

import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * #1067: a coroutine cancellation (Compose's LeftCompositionCancellationException
 * and ForgottenCoroutineScopeException are both [CancellationException]s) is a
 * scope being torn down, never an error. The desktop admin shares the
 * auntieos-admin Sentry project with Android, so it gets the same guard.
 */
class CancellationGuardTest {

    private class LeftComposition : CancellationException("The coroutine scope left the composition")

    @AfterTest fun restore() {
        errorSink = ::reportError
    }

    @Test fun nullAndPlainExceptionsAreNotCancellation() {
        assertFalse(isCancellation(null))
        assertFalse(isCancellation(IllegalStateException("real")))
    }

    @Test fun directCancellationAndSubclassesAreCancellation() {
        assertTrue(isCancellation(CancellationException("stop")))
        assertTrue(isCancellation(LeftComposition()))
    }

    @Test fun chainedCancellationIsCancellation() {
        assertTrue(isCancellation(RuntimeException("wrapped", LeftComposition())))
        assertTrue(isCancellation(RuntimeException("a", IllegalStateException("b", CancellationException("c")))))
    }

    @Test fun loopingCauseChainTerminates() {
        val a = RuntimeException("a")
        val b = RuntimeException("b", a)
        a.initCause(b)
        assertFalse(isCancellation(a))
    }

    @Test fun handlerDoesNotReportAChainedCancellation() {
        var seen: Throwable? = null
        errorSink = { t, _ -> seen = t }
        reportingExceptionHandler("screen:Directory")
            .handleException(EmptyCoroutineContext, RuntimeException("wrapped", LeftComposition()))
        assertNull(seen)
    }

    @Test fun handlerStillReportsARealFailure() {
        var seen: Throwable? = null
        errorSink = { t, _ -> seen = t }
        val boom = IllegalStateException("real")
        reportingExceptionHandler("screen:Directory").handleException(EmptyCoroutineContext, boom)
        assertSame(boom, seen)
    }
}
