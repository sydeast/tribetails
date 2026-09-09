package com.tribetails.auntieos

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.tribetails.auntieos.fcm.AuntieFirebaseMessagingService
import com.tribetails.auntieos.config.FeatureFlags
import com.tribetails.auntieos.data.model.MessageEvent
import com.tribetails.auntieos.ui.AuntieNavHost
import com.tribetails.auntieos.ui.theme.AccentChoice
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.DensityChoice
import com.tribetails.auntieos.ui.theme.FontScaleChoice
import com.tribetails.auntieos.ui.theme.parseThemeMode
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.util.CallEventStore
import com.tribetails.auntieos.util.MessageStore
import com.tribetails.auntieos.util.VoicemailStore
import com.tribetails.auntieos.util.personalizationFlow
import com.tribetails.auntieos.util.saveAccent
import com.tribetails.auntieos.util.saveDensity
import com.tribetails.auntieos.util.saveFcmToken
import com.tribetails.auntieos.util.saveFontScale
import com.tribetails.auntieos.util.saveThemeMode
import com.tribetails.auntieos.util.themeModeFlow
import com.tribetails.auntieos.util.isFcmUnavailable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val requestNotifPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> 
        AuntieLog.i("Notification permission granted: $granted")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        AuntieLog.d("MainActivity onCreate")

        requestNotificationPermission()
        refreshFcmToken()
        handleIncomingIntent()

        val startOnCalls = intent?.action == AuntieFirebaseMessagingService.ACTION_OPEN_CALL
                        || intent?.action == AuntieFirebaseMessagingService.ACTION_OPEN_VOICEMAIL
        val startOnMessages = intent?.action == AuntieFirebaseMessagingService.ACTION_OPEN_MESSAGE

        setContent {
            val themeMode by applicationContext.themeModeFlow()
                .collectAsState(initial = com.tribetails.auntieos.ui.theme.ThemeMode.DARK)
            val personalization by applicationContext.personalizationFlow()
                .collectAsState(initial = com.tribetails.auntieos.ui.theme.ThemePersonalization())

            // 0A + 17.1: reconcile the device theme + personalization from the operator's
            // cloud profile so choices set on web/desktop follow them here. DataStore stays
            // the boot cache; only non-blank cloud fields overwrite it.
            LaunchedEffect(Unit) {
                val user = FirebaseAuth.getInstance().currentUser ?: return@LaunchedEffect
                AuntieOSApp.instance.repository.observeUserProfile(user.uid).collect { profile ->
                    profile ?: return@collect
                    profile.themeMode.takeIf { it.isNotBlank() }?.let {
                        val parsed = parseThemeMode(it)
                        if (parsed != applicationContext.themeModeFlow().first()) {
                            applicationContext.saveThemeMode(parsed)
                        }
                    }
                    // Guard each write (like themeMode above) so a stable cloud value
                    // does not re-churn DataStore + recomposition on every emission.
                    val currentPers = applicationContext.personalizationFlow().first()
                    profile.accentColor.takeIf { it.isNotBlank() }?.let {
                        val parsed = AccentChoice.parse(it)
                        if (parsed != currentPers.accent) applicationContext.saveAccent(parsed)
                    }
                    profile.density.takeIf { it.isNotBlank() }?.let {
                        val parsed = DensityChoice.parse(it)
                        if (parsed != currentPers.density) applicationContext.saveDensity(parsed)
                    }
                    profile.fontScale.takeIf { it.isNotBlank() }?.let {
                        val parsed = FontScaleChoice.parse(it)
                        if (parsed != currentPers.fontScale) applicationContext.saveFontScale(parsed)
                    }
                }
            }

            AuntieOSTheme(themeMode = themeMode, personalization = personalization) {
                AuntieNavHost(
                    startOnCalls = startOnCalls,
                    startOnMessages = startOnMessages
                )
            }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        AuntieLog.d("MainActivity onNewIntent: ${intent.action}")
        setIntent(intent)
        when (intent.action) {
            AuntieFirebaseMessagingService.ACTION_OPEN_CALL     -> handleCallIntent(intent)
            AuntieFirebaseMessagingService.ACTION_OPEN_VOICEMAIL -> handleVoicemailIntent(intent)
            AuntieFirebaseMessagingService.ACTION_OPEN_MESSAGE   -> handleMessageIntent(intent)
        }
    }

    private fun handleIncomingIntent() {
        val currentIntent = intent
        if (currentIntent != null) {
            AuntieLog.d("Handling incoming intent: ${currentIntent.action}")
            when (currentIntent.action) {
                AuntieFirebaseMessagingService.ACTION_OPEN_CALL     -> handleCallIntent(currentIntent)
                AuntieFirebaseMessagingService.ACTION_OPEN_VOICEMAIL -> handleVoicemailIntent(currentIntent)
                AuntieFirebaseMessagingService.ACTION_OPEN_MESSAGE   -> handleMessageIntent(currentIntent)
            }
        }
    }

    // WARNING-8 (inbound-comms server-authoritative gate):
    // The FCM data payloads for call/voicemail/sms are untrusted (no HMAC/nonce).
    // The client below ALSO persists those records to calls_log/voicemails/sms_messages,
    // so a spoofed push can forge records. MyTribe now has server-side Twilio webhooks
    // (twilioInboundSms/Voicemail/Call) that write those records authoritatively.
    //
    // This is gated behind FeatureFlags.inboundCommsServerAuthoritative
    // ("auntieos.inboundComms.serverAuthoritative"), shipping OFF (dark):
    //   - flag OFF (default): keep today's behavior - the client writes (no data loss
    //     before the operator has verified the server path).
    //   - flag ON: the client SKIPS the write (server is the sole, authoritative writer),
    //     closing the spoofed-push vuln. The notification display / navigation stays.
    //
    // Fail-safe: the flag is read via the same getFeatureFlags callable the rest of the
    // app uses; if it can't be read for ANY reason we fall back to DEFAULT (flag OFF =
    // write), so inbound records are never silently lost. The persist decision is the
    // pure FeatureFlags.shouldPersistInboundFromPush(flags) (unit-tested in FeatureFlagsTest).

    /**
     * Resolves the CURRENT effective feature flags outside Compose (the intent handlers
     * are not composables). Mirrors the Compose root: fetch sparse overrides via
     * getFeatureFlags, then layer them onto the compile-time defaults with fromOverrides.
     * On ANY failure, returns DEFAULT - the SAFE-for-data baseline (WARNING-8 flag OFF =
     * client still writes), so a transient fetch error never drops inbound records.
     */
    private suspend fun resolveEffectiveFlags(): FeatureFlags =
        AuntieOSApp.instance.repository.getFeatureFlags()
            .map { FeatureFlags.fromOverrides(it) }
            .getOrElse { FeatureFlags.DEFAULT }

    private fun handleCallIntent(intent: android.content.Intent) {
        val callSid      = intent.getStringExtra(AuntieFirebaseMessagingService.EXTRA_CALL_SID)      ?: ""
        val callerNumber = intent.getStringExtra(AuntieFirebaseMessagingService.EXTRA_CALLER_NUMBER) ?: "Unknown"
        val transcript   = intent.getStringExtra(AuntieFirebaseMessagingService.EXTRA_TRANSCRIPT)    ?: ""
        val popupUrl     = intent.getStringExtra(AuntieFirebaseMessagingService.EXTRA_POPUP_URL)     ?: ""

        AuntieLog.i("Handling call intent for: $callerNumber")

        if (callSid.isBlank() && popupUrl.isBlank()) return

        val exists = CallEventStore.events.value.any { it.callSid == callSid && callSid.isNotBlank() }
        if (!exists) {
            AuntieLog.d("Adding new call event to store")
            CallEventStore.addEvent(
                com.tribetails.auntieos.data.model.CallEvent(
                    callSid      = callSid,
                    callerNumber = callerNumber,
                    transcript   = transcript,
                    popupUrl     = popupUrl
                )
            )
        }

        // WARNING-8: gated client write. Flag OFF (default) -> client writes (today's
        // behavior). Flag ON -> skip; the server Twilio webhook (twilioInboundCall) is
        // the authoritative writer. Flag read fail-safe: unreadable -> DEFAULT (write).
        CoroutineScope(Dispatchers.IO).launch {
            if (FeatureFlags.shouldPersistInboundFromPush(resolveEffectiveFlags())) {
                AuntieOSApp.instance.repository
                    .upsertInboundCallLog(callSid = callSid, callerNumber = callerNumber, transcript = transcript, popupUrl = popupUrl)
                    .onFailure { AuntieLog.e("Failed to persist inbound call log", it) }
            } else {
                AuntieLog.d("WARNING-8: server authoritative, skipping client calls_log write for $callSid")
            }
        }
    }

    private fun handleVoicemailIntent(intent: android.content.Intent) {
        val callerNumber = intent.getStringExtra(AuntieFirebaseMessagingService.EXTRA_CALLER_NUMBER) ?: "Unknown"
        val transcript   = intent.getStringExtra(AuntieFirebaseMessagingService.EXTRA_TRANSCRIPT)    ?: ""
        val playUrl      = intent.getStringExtra(AuntieFirebaseMessagingService.EXTRA_PLAY_URL)      ?: ""

        AuntieLog.i("Handling voicemail intent from: $callerNumber")

        val exists = VoicemailStore.voicemails.value.any {
            it.callerNumber == callerNumber && it.playUrl == playUrl
        }
        if (!exists) {
            AuntieLog.d("Adding new voicemail event to store")
            VoicemailStore.addVoicemail(
                com.tribetails.auntieos.data.model.VoicemailEvent(callerNumber, transcript, playUrl)
            )
        }

        // WARNING-8: gated client write. Flag OFF (default) -> client writes (today's
        // behavior). Flag ON -> skip; the server Twilio webhook (twilioInboundVoicemail)
        // is the authoritative writer. Flag read fail-safe: unreadable -> DEFAULT (write).
        CoroutineScope(Dispatchers.IO).launch {
            if (FeatureFlags.shouldPersistInboundFromPush(resolveEffectiveFlags())) {
                AuntieOSApp.instance.repository
                    .createInboundVoicemailLog(callerNumber = callerNumber, transcript = transcript, audioUrl = playUrl)
                    .onFailure { AuntieLog.e("Failed to persist inbound voicemail", it) }
            } else {
                AuntieLog.d("WARNING-8: server authoritative, skipping client voicemails write from $callerNumber")
            }
        }
    }

    private fun handleMessageIntent(intent: android.content.Intent) {
        val from = intent.getStringExtra("from") ?: "Unknown"
        val body = intent.getStringExtra("body") ?: ""
        MessageStore.addMessage(
            MessageEvent(
                messageSid = "push_${System.currentTimeMillis()}",
                body = body,
                senderNumber = from,
                type = "sms",
                direction = "inbound"
            )
        )
        // WARNING-8: gated client write. Flag OFF (default) -> client writes (today's
        // behavior). Flag ON -> skip; the server Twilio webhook (twilioInboundSms) is
        // the authoritative writer. Flag read fail-safe: unreadable -> DEFAULT (write).
        CoroutineScope(Dispatchers.IO).launch {
            if (FeatureFlags.shouldPersistInboundFromPush(resolveEffectiveFlags())) {
                AuntieOSApp.instance.repository
                    .createInboundSmsLog(from = from, body = body)
                    .onFailure { AuntieLog.e("Failed to persist inbound SMS", it) }
            } else {
                AuntieLog.d("WARNING-8: server authoritative, skipping client sms_messages write from $from")
            }
        }
        AuntieLog.d("Message intent handled")
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                AuntieLog.d("Requesting notification permission")
                requestNotifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun refreshFcmToken() {
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            AuntieLog.d("FCM Token refreshed: ${token.take(10)}...")
            CoroutineScope(Dispatchers.IO).launch {
                applicationContext.saveFcmToken(token)
                AuntieOSApp.instance.repository.saveDeviceToken(token)
            }
        }.addOnFailureListener { e ->
            // AUNTIEOS-ADMIN-W: on a device with no Play Services (an AOSP
            // emulator, mainly) this fails with IOException
            // "MISSING_INSTANCEID_SERVICE"/"SERVICE_NOT_AVAILABLE" every launch.
            // There is no token to register in that case and no retry fixes it,
            // so this logs and skips registration (saveDeviceToken above is
            // simply never reached) rather than reporting a Sentry error for a
            // device shape the app cannot do anything about.
            if (isFcmUnavailable(e)) {
                AuntieLog.i("FCM unavailable on this device (${e.message}); skipping push registration")
            } else {
                AuntieLog.e("Failed to refresh FCM token", e)
            }
        }
    }
}
