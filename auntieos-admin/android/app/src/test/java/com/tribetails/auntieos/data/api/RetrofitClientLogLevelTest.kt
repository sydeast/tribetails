package com.tribetails.auntieos.data.api

import okhttp3.logging.HttpLoggingInterceptor
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Verifies that [resolveHttpLogLevel] gates BODY logging behind the debug flag.
 *
 * Note: unit tests run against the debug variant so BuildConfig.DEBUG == true at
 * runtime here — that branch is exercised by the debug build itself. The release
 * branch (isDebug = false) is covered by passing the argument directly since the
 * pure helper has no dependency on the build variant.
 */
class RetrofitClientLogLevelTest {

    @Test
    fun `resolveHttpLogLevel returns BODY when isDebug is true`() {
        assertEquals(
            HttpLoggingInterceptor.Level.BODY,
            resolveHttpLogLevel(isDebug = true)
        )
    }

    @Test
    fun `resolveHttpLogLevel returns NONE when isDebug is false`() {
        assertEquals(
            HttpLoggingInterceptor.Level.NONE,
            resolveHttpLogLevel(isDebug = false)
        )
    }
}
