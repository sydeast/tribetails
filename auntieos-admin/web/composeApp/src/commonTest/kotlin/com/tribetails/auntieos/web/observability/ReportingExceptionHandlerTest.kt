package com.tribetails.auntieos.web.observability

import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame

/**
 * AO-9: proves the coroutine boundary actually routes a typed throwable to the
 * reporter. Before this seam existed, an uncaught wasm coroutine exception
 * escaped to window.onerror and stringified to "[object WebAssembly.Exception]".
 * The bug WAS the missing call, so a test that the call happens is the fix's
 * only honest proof.
 */
class ReportingExceptionHandlerTest {

    @AfterTest fun restore() {
        errorSink = ::reportError
    }

    @Test fun routesThrowableAndContextToTheSink() {
        var seenThrowable: Throwable? = null
        var seenContext: String? = "unset"
        errorSink = { t, c -> seenThrowable = t; seenContext = c }

        val boom = IllegalStateException("directory blew up")
        reportingExceptionHandler("screen:Directory")
            .handleException(EmptyCoroutineContext, boom)

        assertSame(boom, seenThrowable, "the original typed throwable must reach the sink")
        assertEquals("screen:Directory", seenContext)
    }

    @Test fun defaultsContextToNull() {
        var seenContext: String? = "unset"
        errorSink = { _, c -> seenContext = c }

        reportingExceptionHandler()
            .handleException(EmptyCoroutineContext, RuntimeException("x"))

        assertNull(seenContext)
    }
}
