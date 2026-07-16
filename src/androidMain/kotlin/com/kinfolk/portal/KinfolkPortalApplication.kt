package com.kinfolk.portal

import android.app.Application
import android.content.Context
import android.os.Build
import android.util.Log
import io.sentry.android.core.SentryAndroid

class KinfolkPortalApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        appContext = applicationContext

        // Read any pre-Sentry crash from the previous launch. Forwarded to
        // Sentry after init so cold-launch crashes that pre-empt Sentry are
        // still visible in the dashboard.
        val priorCrashReport = readPreviousCrashReport(applicationContext)

        // Install the uncaught-exception handler BEFORE Sentry init so even a
        // crash inside Sentry.init() leaves a stacktrace on disk for the next
        // launch to recover.
        installDefensiveCrashHandler(applicationContext)

        // Skip Sentry under Robolectric so unit-test runs don't pollute the
        // production project (see AUNTIEOS-ADMIN-4 retrofit-404 incident:
        // 67 fake "users" / 476 events from robolectric runs reporting to
        // prod). FINGERPRINT under Robolectric contains "robolectric".
        val isRobolectric =
            Build.FINGERPRINT?.contains("robolectric", ignoreCase = true) == true
        if (!isRobolectric && SENTRY_DSN.isNotBlank()) {
            try {
                SentryAndroid.init(this) { options ->
                    options.dsn = SENTRY_DSN
                    options.environment = "production"
                    options.release = "com.kinfolk.portal@0.2.0+2"
                    options.isEnableAutoSessionTracking = true
                }
                if (priorCrashReport != null) {
                    io.sentry.Sentry.captureMessage(
                        "pre-sentry-crash recovered from disk\n$priorCrashReport",
                        io.sentry.SentryLevel.FATAL
                    )
                }
            } catch (t: Throwable) {
                Log.e(TAG, "Sentry init failed", t)
            }
        }
    }

    companion object {
        private const val TAG = "KinfolkPortalApp"

        // Public DSN — sentry-android DSNs are designed to be embedded in
        // shipped binaries. Rate-limit + project-scope are enforced server-side.
        private const val SENTRY_DSN =
            "https://30ae974c24b363cfd621ad377924d4a1@o4511074771533824.ingest.us.sentry.io/4511343937847296"

        @Volatile
        var appContext: Context? = null
            private set
    }
}

private const val CRASH_FILE = "last_crash.txt"

private fun installDefensiveCrashHandler(ctx: Context) {
    val prior = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
        try {
            val sb = StringBuilder()
            sb.append("thread=").append(thread.name).append('\n')
            sb.append("when=").append(System.currentTimeMillis()).append('\n')
            sb.append("os.sdk=").append(Build.VERSION.SDK_INT).append('\n')
            sb.append("device=").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n')
            sb.append("fingerprint=").append(Build.FINGERPRINT).append('\n')
            sb.append("---\n")
            sb.append(android.util.Log.getStackTraceString(throwable))
            ctx.openFileOutput(CRASH_FILE, Context.MODE_PRIVATE).use { it.write(sb.toString().toByteArray()) }
        } catch (_: Throwable) {
            // best-effort — do not mask the original crash
        }
        prior?.uncaughtException(thread, throwable)
    }
}

private fun readPreviousCrashReport(ctx: Context): String? {
    return try {
        val f = ctx.getFileStreamPath(CRASH_FILE) ?: return null
        if (!f.exists()) return null
        val text = f.readText()
        android.util.Log.e("KinfolkPortalApp", "Recovered prior-launch crash:\n$text")
        f.delete()
        text
    } catch (_: Throwable) {
        null
    }
}
