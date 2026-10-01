package com.tribetails.auntieos.util

import io.mockk.every
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import io.mockk.verify
import io.sentry.Sentry
import io.sentry.SentryLevel
import io.sentry.protocol.SentryId
import kotlinx.coroutines.CancellationException
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * #1067: [AuntieLog.e]/[AuntieLog.w] must never send a coroutine cancellation
 * to Sentry, whether it arrives bare or chained under a wrapper. A real
 * exception still goes through.
 */
class AuntieLogCancellationTest {

    private class ForgottenScope : CancellationException("rememberCoroutineScope left the composition")

    @Before
    fun setUp() {
        mockkStatic(Sentry::class)
        every { Sentry.captureException(any()) } returns SentryId.EMPTY_ID
        every { Sentry.captureMessage(any(), any<SentryLevel>()) } returns SentryId.EMPTY_ID
        every { Sentry.addBreadcrumb(any<String>()) } returns Unit
    }

    @After
    fun tearDown() {
        unmockkStatic(Sentry::class)
    }

    @Test
    fun `error with a bare cancellation is not captured`() {
        AuntieLog.e("load failed", ForgottenScope())
        verify(exactly = 0) { Sentry.captureException(any()) }
        verify(exactly = 0) { Sentry.captureMessage(any(), any<SentryLevel>()) }
    }

    @Test
    fun `warning with a bare cancellation is not captured`() {
        AuntieLog.w("load failed", CancellationException("stop"))
        verify(exactly = 0) { Sentry.captureException(any()) }
    }

    @Test
    fun `error with a chained cancellation is not captured`() {
        AuntieLog.e("load failed", RuntimeException("wrapped", ForgottenScope()))
        verify(exactly = 0) { Sentry.captureException(any()) }
    }

    @Test
    fun `error with a real exception is captured`() {
        val real = IllegalStateException("real defect")
        AuntieLog.e("load failed", real)
        verify(exactly = 1) { Sentry.captureException(real) }
    }
}
