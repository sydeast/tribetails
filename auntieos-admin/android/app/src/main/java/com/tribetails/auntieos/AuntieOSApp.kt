package com.tribetails.auntieos

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import com.tribetails.auntieos.BuildConfig
import com.tribetails.auntieos.config.MapboxConfig
import com.tribetails.auntieos.data.api.RetrofitClient
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.ServiceRepository
import com.tribetails.auntieos.location.BreadcrumbDispatcher
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.util.baseUrlFlow
import com.tribetails.auntieos.util.saveBaseUrl
import com.tribetails.auntieos.session.SessionHealthMonitor
import com.tribetails.auntieos.voice.VoiceRegistrationCoordinator
import com.tribetails.auntieos.voice.VoiceTokenManager
import io.sentry.android.core.SentryAndroid
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking

class AuntieOSApp : Application() {

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** An n8n base URL and the repository built from it, kept together. */
    private class N8nWiring(val baseUrl: String, val repository: AuntieRepository)

    /**
     * Built from the STORED base URL, on first read, and not before.
     *
     * This used to be a repository built at construction from the default URL,
     * which `onCreate` then replaced from a coroutine once it had read the
     * stored one. That left a window: any caller that read `repository` before
     * the coroutine finished got the default-URL instance and kept it, and the
     * only thing making that harmless was a comment (below, on
     * `VoiceTokenManager.initialize`) arguing that the swapped-in difference did
     * not matter to that caller. That argument was correct and one code change
     * away from being wrong.
     *
     * Resolving here instead deletes the window rather than documenting it: the
     * first read is the only read that can resolve anything, so no caller can
     * hold an instance built from a URL the app has already superseded. It also
     * removes the startup coroutine outright, which matters beyond ordering —
     * that coroutine ran on [appScope], which nothing cancels, and wrote into a
     * field of an Application that Robolectric rebuilds for every test method.
     * That is the exact shape of the leak fixed in #425.
     *
     * The cost is one small DataStore read on whichever thread reads
     * `repository` first, which in production is `onCreate` itself. A blocking
     * preferences read at cold start is a real cost and is the price of there
     * being no window at all.
     */
    private val startupWiring: N8nWiring by lazy { resolveStartupWiring() }

    /** Set only by [rebuildRepository], the operator changing the URL in Settings. */
    @Volatile
    private var rebuiltWiring: N8nWiring? = null

    private val wiring: N8nWiring get() = rebuiltWiring ?: startupWiring

    val repository: AuntieRepository get() = wiring.repository

    /**
     * The n8n base URL [repository] is actually built from, which is the whole
     * question this file used to answer with a race. Reading it resolves the
     * wiring exactly as reading [repository] does, so the two can never
     * disagree, and a test can ask which URL the live repository came from
     * without reaching inside a Retrofit proxy.
     */
    val activeBaseUrl: String get() = wiring.baseUrl

    val bookingRepository: BookingRepository by lazy { BookingRepository() }
    val serviceRepository: ServiceRepository by lazy { ServiceRepository() }

    /**
     * W4-1: the Invoice domain repo, first carve out of the AuntieRepository
     * god-file. W4-2 removed the wiring that used to live here: it took its
     * TestMode as a lambda reading `repository` at call time, so that a
     * [rebuildRepository] could not strand it on a dead claim cache. Both repos
     * now default to `AuthGate.shared`, which no rebuild replaces, so the claim
     * is read and cached in one place without this file arranging it.
     */
    val invoiceRepository: InvoiceRepository by lazy { InvoiceRepository() }

    /**
     * W4-3: the KinCare domain repo. Same wiring as [invoiceRepository] and for
     * the same reason: it defaults to `AuthGate.shared`, which no
     * [rebuildRepository] replaces, so a base-url change cannot strand it on a
     * dead `testTribeId` cache and this file arranges nothing.
     */
    val kinCareRepository: KinCareRepository by lazy { KinCareRepository() }

    /**
     * Drives Twilio Voice registration off the admin auth state instead of off
     * process start (#433). Held here rather than created inline so its collector
     * has an owner that can stop it.
     */
    val voiceRegistration: VoiceRegistrationCoordinator by lazy { VoiceRegistrationCoordinator() }

    val mediaUploadManager: MediaUploadManager by lazy { MediaUploadManager(applicationContext, repository) }
    val visitNotifier: VisitNotifier by lazy { VisitNotifier() }
    val breadcrumbDispatcher: BreadcrumbDispatcher by lazy {
        BreadcrumbDispatcher(repository = kinCareRepository, scope = appScope)
    }

    override fun onCreate() {
        super.onCreate()
        instance = this

        // Read any pre-Sentry crash from the previous launch attempt. This
        // exists because v0.2.0 sideloads on Android 16 (API 36) crashed during
        // cold launch with zero Sentry events captured - meaning the crash is
        // upstream of Sentry.init. Without this, every crash-loop session is
        // observable only via `adb logcat`. With this, the next launch logs
        // the prior stacktrace AND forwards it to Sentry once init succeeds.
        val priorCrashReport = readPreviousCrashReport(applicationContext)

        // Install the on-disk uncaught handler BEFORE Sentry.init so even a
        // crash inside SentryAndroid.init() leaves a recoverable stacktrace.
        installDefensiveCrashHandler(applicationContext)

        // The Maps SDK's access token, set here and nowhere else, because
        // Application.onCreate is the only place that runs before every Activity
        // and Composable - including the two screens that build a MapView.
        //
        // This is the fix for a screen that has been blank in production since it
        // was written: LiveTrackingScreen and RouteViewerScreen were wired to the
        // SDK, but nothing ever authenticated it, so every tile request they made
        // was rejected. Not a regression from the July geocoding-key removal; that
        // constant had one reader and it was not these screens.
        //
        // Deliberately NOT inside the isRobolectric guard below. Sentry and voice
        // registration are skipped under test because they leak work across the
        // shared JVM; this leaks nothing, and it is the thing the test observes.
        // applyAccessToken swallows the UnsatisfiedLinkError the native SDK
        // raises under Robolectric and records that startup did its part.
        val mapboxToken = MapboxConfig.applyAccessToken(BuildConfig.MAPBOX_PUBLIC_TOKEN)
        if (mapboxToken is MapboxConfig.TokenApplication.NoTokenConfigured) {
            AuntieLog.w("No MAPBOX_PUBLIC_TOKEN in this build: maps will not draw")
        }

        // Are we running inside the JVM unit-test suite? Two pieces of startup
        // below are skipped when we are: Sentry, because unit-test runs were
        // polluting the production project (AUNTIEOS-ADMIN-4 retrofit 404: 476
        // events / 67 fake "users", all tagged device.family=robolectric), and
        // the voice registration further down, because the background work it
        // starts outlives the test that created this Application (#425).
        val isRobolectric =
            Build.FINGERPRINT?.contains("robolectric", ignoreCase = true) == true
        val sentryDsn = BuildConfig.SENTRY_DSN
        if (!isRobolectric && sentryDsn.isNotBlank()) {
            try {
                SentryAndroid.init(this) { options ->
                    options.dsn = sentryDsn
                    options.setBeforeSend { event, _ -> event }
                }
                if (priorCrashReport != null) {
                    io.sentry.Sentry.captureMessage(
                        "pre-sentry-crash recovered from disk\n$priorCrashReport",
                        io.sentry.SentryLevel.FATAL
                    )
                }
            } catch (t: Throwable) {
                AuntieLog.e("Sentry init failed", t)
            }
        }

        AuntieLog.i("AuntieOSApp created")
        
        createNotificationChannels()

        // Voice tokens come from the admin-gated `mintVoiceAccessToken` callable
        // now, not from the public Twilio Functions endpoint, so this takes the
        // repository rather than a Retrofit binding. Reading `repository` here is
        // what resolves the stored base URL, so the instance handed over is the
        // final one for this launch. It can still be replaced later, by the
        // operator editing the URL in Settings, and the captured instance stays
        // correct through that: `rebuildRepository` swaps only the n8n base URL,
        // which callables do not use.
        //
        // WHAT THIS NO LONGER DOES IS THE POINT. `initialize` used to end with a
        // `mintAndRegister`, and running it from here meant minting a voice token
        // before anybody could possibly be signed in. `mintVoiceAccessToken` is
        // admin gated, so on a first launch after install and on every launch
        // after a sign-out that mint was refused, and a refused mint scheduled no
        // retry: the phone then did not ring for inbound business calls for the
        // rest of the process, silently. `initialize` now only hands over the
        // seams, and [voiceRegistration] starts the work when an admin actually
        // appears, which also covers signing out and back in. See issue #433.
        //
        // SKIPPED UNDER ROBOLECTRIC, for the same class of reason as the Sentry
        // skip above, except that this one was corrupting the test suite rather
        // than a dashboard. Both halves below start work on [appScope]
        // (Dispatchers.Default), which nothing ever cancels, while
        // `VoiceTokenManager` is a process-wide `object`. Robolectric builds a
        // fresh AuntieOSApp for EVERY test method and the whole unit-test suite
        // runs in one JVM, so each Robolectric test left another background
        // coroutine alive that would go on to write `Working` and then
        // `Failed(...)` into the shared manager at an arbitrary later moment,
        // inside whatever unrelated test happened to be running by then. That is
        // what made AuntieFirebaseMessagingServiceTest fail order-dependently:
        // its `@Before` reset was correct and simply cannot defend against a
        // writer that arrives after it has run. See issue #425. The auth-state
        // collector added for #433 is a longer-lived coroutine than the one that
        // caused that, so it is skipped here too rather than merely reset.
        if (isRobolectric) {
            AuntieLog.d("Skipping voice registration under Robolectric")
        } else {
            try {
                VoiceTokenManager.initialize(this, repository, appScope)
                val sessionUids = repository.authStateFlow().map { it?.uid }
                voiceRegistration.start(scope = appScope, sessionUids = sessionUids)
                // #454: watch whether the signed-in session can still renew its
                // ID token. Started from the same auth-state flow and skipped
                // under Robolectric for the same reasons as the block above:
                // it is a process-wide object holding a long-lived collector.
                SessionHealthMonitor.start(scope = appScope, sessionUids = sessionUids)
            } catch (e: Exception) {
                AuntieLog.e("Failed to initialize voice registration", e)
            }
        }
    }

    private fun buildRepo(baseUrl: String) = AuntieRepository(
        n8n = RetrofitClient.buildN8n(baseUrl)
    )

    /**
     * Reads the stored base URL, migrating a stale one, and builds the
     * repository for it. Both halves are fail-safe to the default, because a
     * device that cannot be read from, or that has a URL Retrofit rejects
     * stored from before [saveBaseUrl] validated its input, still has to get an
     * app it can sign into.
     *
     * The DataStore read blocks the calling thread deliberately. Handing the
     * caller a repository built from the wrong URL and correcting it a moment
     * later is what this change exists to stop, and there is no non-blocking
     * way to answer "which URL" to a caller that is not itself suspending.
     */
    private fun resolveStartupWiring(): N8nWiring {
        val url = try {
            runBlocking {
                val savedUrl = applicationContext.baseUrlFlow().first()
                if (savedUrl.contains(RetrofitClient.LEGACY_N8N_HOST)) {
                    AuntieLog.i("Migrating stale base_url '$savedUrl' → ${RetrofitClient.DEFAULT_BASE_URL}")
                    applicationContext.saveBaseUrl(RetrofitClient.DEFAULT_BASE_URL)
                    RetrofitClient.DEFAULT_BASE_URL
                } else savedUrl
            }
        } catch (e: Exception) {
            AuntieLog.e("Failed to load saved URL", e)
            RetrofitClient.DEFAULT_BASE_URL
        }
        return try {
            AuntieLog.i("Building repository with base URL: $url")
            N8nWiring(url, buildRepo(url))
        } catch (e: Exception) {
            AuntieLog.e("Saved base URL '$url' is not usable, falling back to the default", e)
            N8nWiring(RetrofitClient.DEFAULT_BASE_URL, buildRepo(RetrofitClient.DEFAULT_BASE_URL))
        }
    }

    fun rebuildRepository(baseUrl: String) {
        AuntieLog.i("Rebuilding repository: $baseUrl")
        rebuiltWiring = N8nWiring(baseUrl, buildRepo(baseUrl))
    }

    private fun createNotificationChannels() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // 1. Call Channel (Highest Priority, Custom Sound)
        val callChannel = NotificationChannel(
            CALL_CHANNEL_ID,
            "Incoming Calls",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Tribe Tails call screening and live calls"
            enableVibration(true)
            enableLights(true)
        }
        nm.createNotificationChannel(callChannel)

        // 2. Message Channel (High Priority, Custom Sound)
        val msgChannel = NotificationChannel(
            MESSAGE_CHANNEL_ID,
            "New Messages",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Tribe Tails SMS and RCS messages"
            enableVibration(true)
        }
        nm.createNotificationChannel(msgChannel)
    }

    companion object {
        const val CALL_CHANNEL_ID = "tribe_tails_calls"
        const val MESSAGE_CHANNEL_ID = "tribe_tails_messages"
        lateinit var instance: AuntieOSApp
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
            sb.append("version=").append(BuildConfig.VERSION_NAME).append('+').append(BuildConfig.VERSION_CODE).append('\n')
            sb.append("---\n")
            sb.append(Log.getStackTraceString(throwable))
            ctx.openFileOutput(CRASH_FILE, Context.MODE_PRIVATE).use { it.write(sb.toString().toByteArray()) }
        } catch (_: Throwable) {
            // best-effort - do not mask the original crash
        }
        prior?.uncaughtException(thread, throwable)
    }
}

private fun readPreviousCrashReport(ctx: Context): String? {
    return try {
        val f = ctx.getFileStreamPath(CRASH_FILE) ?: return null
        if (!f.exists()) return null
        val text = f.readText()
        Log.e("AuntieOSApp", "Recovered prior-launch crash:\n$text")
        f.delete()
        text
    } catch (_: Throwable) {
        null
    }
}
