package com.tribetails.auntieos.web.observability

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CrashReporterTest {
    @Test fun disabled_whenDsnNullOrBlank() {
        assertFalse(crashReportingEnabled(null))
        assertFalse(crashReportingEnabled(""))
        assertFalse(crashReportingEnabled("   "))
    }

    @Test fun enabled_whenDsnPresent() {
        assertTrue(crashReportingEnabled(AUNTIEOS_SENTRY_DSN))
        assertTrue(crashReportingEnabled("https://key@o1.ingest.us.sentry.io/2"))
    }
}
