package com.tribetails.auntieos

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Pins the leak that ran the whole Android suite out of memory (#2301).
 *
 * `AuntieOSApp.onCreate` installs a default uncaught-exception handler that
 * writes the crash to disk. It used to install a NEW one on every call, each
 * capturing the previous handler and its own Application. The default handler
 * is one static for the whole JVM, Robolectric builds an Application per test
 * method, and the suite runs in one JVM, so the chain grew by one Application
 * (and its resource tables) per Robolectric test until the heap was gone. A
 * class histogram of the test worker a few minutes in showed 568 live
 * AuntieOSApp instances.
 *
 * The first test fails against that code deterministically: a second
 * `onCreate` replaced the handler. The second pins the half that must survive
 * the fix, that the one handler still writes for the Application that is
 * current rather than for whichever one happened to install it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AuntieOSAppCrashHandlerTest {

    private val app: AuntieOSApp
        get() = RuntimeEnvironment.getApplication() as AuntieOSApp

    @Test
    fun starting_the_application_again_does_not_stack_another_crash_handler() {
        // Robolectric has already run onCreate once for this test.
        val installed = Thread.getDefaultUncaughtExceptionHandler()
        assertNotNull("app startup installs the on-disk crash handler", installed)

        app.onCreate()
        app.onCreate()

        assertSame(
            "every onCreate wrapped the previous handler, which keeps every " +
                "Application a test run has created reachable from a JVM-wide static",
            installed,
            Thread.getDefaultUncaughtExceptionHandler(),
        )
    }

    @Test
    fun the_crash_handler_writes_the_report_for_the_current_application() {
        val crashFile = app.getFileStreamPath("last_crash.txt")
        crashFile.delete()

        Thread.getDefaultUncaughtExceptionHandler()!!
            .uncaughtException(Thread.currentThread(), IllegalStateException("boom-2301"))

        assertTrue("the crash report was not written for this Application", crashFile.exists())
        val report = crashFile.readText()
        assertTrue("the report carries the stack trace, got: $report", report.contains("boom-2301"))
        crashFile.delete()
    }
}
