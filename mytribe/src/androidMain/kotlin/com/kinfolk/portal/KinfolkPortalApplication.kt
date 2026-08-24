package com.kinfolk.portal

import android.app.Application
import android.content.Context
import android.os.Build
import android.util.Log
import com.kinfolk.portal.attestation.activateAppCheck
import com.kinfolk.portal.config.MapboxPortalConfig
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

        // The Maps SDK's access token, set here and nowhere else, because
        // Application.onCreate is the only place that runs before every Activity
        // and Composable - including RouteMap, the one screen element that
        // builds a MapView. Issue #520: a kinfolk watching a KinCare visit has
        // to see actual streets, and Maps SDK v11 cannot load a style without a
        // credential.
        //
        // Deliberately NOT inside the isRobolectric guard below. Sentry is
        // skipped under test because it leaks events into the production
        // project; this leaks nothing, and it is the thing the test observes.
        // applyAccessToken swallows the UnsatisfiedLinkError the native SDK
        // raises under Robolectric and records that startup did its part.
        val mapboxToken = MapboxPortalConfig.applyAccessToken(BuildConfig.MAPBOX_PUBLIC_TOKEN)
        if (mapboxToken is MapboxPortalConfig.TokenApplication.NoTokenConfigured) {
            // Not a crash and not a user-facing error: RouteMap draws the Canvas
            // polyline instead, which is what shipped before #520.
            Log.w(TAG, "No MAPBOX_PUBLIC_TOKEN in this build: routes draw without a basemap")
        }

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

        // App Check (O-3 ruling D1, Phase 2). After Sentry, so a failed
        // attestation has somewhere to be reported; before any screen can make
        // a callable, which is what an Application.onCreate is for.
        //
        // Skipped under Robolectric for the same reason Sentry is: there is no
        // FirebaseApp in a unit-test JVM, so this would report a failure that
        // says nothing about the shipped app.
        if (!isRobolectric) {
            val debuggable =
                (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
            activateAppCheck(useDebugProvider = debuggable)
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
