package com.kinfolk.portal.error

import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1067: the portal's Sentry `beforeSend` uses [isCancellation] to drop a
 * coroutine cancellation, bare or chained, while keeping every real failure.
 */
class CancellationGuardTest {

    private class LeftComposition : CancellationException("The coroutine scope left the composition")

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
}
