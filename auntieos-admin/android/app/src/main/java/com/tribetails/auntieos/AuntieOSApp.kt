package com.tribetails.auntieos

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import com.tribetails.auntieos.BuildConfig
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
import com.tribetails.auntieos.voice.VoiceTokenManager
import io.sentry.android.core.SentryAndroid
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class AuntieOSApp : Application() {

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    var repository: AuntieRepository = buildRepo(RetrofitClient.DEFAULT_BASE_URL)
        private set

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

        appScope.launch {
            try {
                val savedUrl = baseUrlFlow().first()
                val effectiveUrl = if (savedUrl.contains(RetrofitClient.LEGACY_N8N_HOST)) {
                    AuntieLog.i("Migrating stale base_url '$savedUrl' → ${RetrofitClient.DEFAULT_BASE_URL}")
                    applicationContext.saveBaseUrl(RetrofitClient.DEFAULT_BASE_URL)
                    RetrofitClient.DEFAULT_BASE_URL
                } else savedUrl
                if (effectiveUrl != RetrofitClient.DEFAULT_BASE_URL) {
                    AuntieLog.i("Rebuilding repository with saved URL: $effectiveUrl")
                    repository = buildRepo(effectiveUrl)
                }
            } catch (e: Exception) {
                AuntieLog.e("Failed to load saved URL", e)
            }
        }

        // Voice tokens come from the admin-gated `mintVoiceAccessToken` callable
        // now, not from the public Twilio Functions endpoint, so this takes the
        // repository rather than a Retrofit binding. `repository` is read at call
        // time; a later `rebuildRepository` swaps only the n8n base URL, which
        // callables do not use, so the captured instance stays correct.
        //
        // SKIPPED UNDER ROBOLECTRIC, for the same class of reason as the Sentry
        // skip above, except that this one was corrupting the test suite rather
        // than a dashboard. `initialize` launches `mintAndRegister` on [appScope]
        // (Dispatchers.Default) and nothing ever cancels that scope, while
        // `VoiceTokenManager` is a process-wide `object`. Robolectric builds a
        // fresh AuntieOSApp for EVERY test method and the whole unit-test suite
        // runs in one JVM, so each Robolectric test left another background
        // coroutine alive that would go on to write `Working` and then
        // `Failed(...)` into the shared manager at an arbitrary later moment,
        // inside whatever unrelated test happened to be running by then. That is
        // what made AuntieFirebaseMessagingServiceTest fail order-dependently:
        // its `@Before` reset was correct and simply cannot defend against a
        // writer that arrives after it has run. See issue #425.
        if (isRobolectric) {
            AuntieLog.d("Skipping VoiceTokenManager.initialize under Robolectric")
        } else {
            try {
                VoiceTokenManager.initialize(this, repository, appScope)
            } catch (e: Exception) {
                AuntieLog.e("Failed to initialize VoiceTokenManager", e)
            }
        }
    }

    private fun buildRepo(baseUrl: String) = AuntieRepository(
        n8n = RetrofitClient.buildN8n(baseUrl)
    )

    fun rebuildRepository(baseUrl: String) {
        AuntieLog.i("Rebuilding repository: $baseUrl")
        repository = buildRepo(baseUrl)
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
