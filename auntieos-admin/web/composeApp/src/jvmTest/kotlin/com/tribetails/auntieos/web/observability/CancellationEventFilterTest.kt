package com.tribetails.auntieos.web.observability

import io.sentry.SentryEvent
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.Test
import kotlin.test.assertNull
import kotlin.test.assertSame

/** #1067: the desktop Sentry `beforeSend` drops cancellation events. */
class CancellationEventFilterTest {

    @Test fun dropsADirectCancellation() {
        assertNull(filterCancellationEvent(SentryEvent(CancellationException("stop"))))
    }

    @Test fun dropsAChainedCancellation() {
        assertNull(filterCancellationEvent(SentryEvent(RuntimeException("wrapped", CancellationException("stop")))))
    }

    @Test fun keepsARealException() {
        val event = SentryEvent(IllegalStateException("real"))
        assertSame(event, filterCancellationEvent(event))
    }

    @Test fun keepsAMessageEvent() {
        val event = SentryEvent()
        assertSame(event, filterCancellationEvent(event))
    }
}
