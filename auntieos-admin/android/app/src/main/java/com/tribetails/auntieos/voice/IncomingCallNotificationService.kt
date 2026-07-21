package com.tribetails.auntieos.voice

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.R
import com.tribetails.auntieos.util.AuntieLog

/**
 * Foreground service that keeps the process alive while a Voice SDK call is active.
 * Started when a call is answered, stopped when the call ends.
 *
 * Also owns the AudioFocusRequest + MODE_IN_COMMUNICATION lifecycle so that
 * incoming calls duck other audio and so that the AudioRouter's
 * setCommunicationDevice calls actually take effect (Android requires
 * MODE_IN_COMMUNICATION for the comm-device API to do anything).
 */
class IncomingCallNotificationService : Service() {

    private var audioFocusRequest: AudioFocusRequest? = null
    private var priorMode: Int = AudioManager.MODE_NORMAL

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                acquireAudioFocus()
                showForegroundNotification()
            }
            ACTION_STOP  -> stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun acquireAudioFocus() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        priorMode = am.mode
        am.mode = AudioManager.MODE_IN_COMMUNICATION

        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(attrs)
            .setOnAudioFocusChangeListener { /* no-op: Twilio Voice handles ducking */ }
            .build()
        val result = am.requestAudioFocus(req)
        if (result == AudioManager.AUDIOFOCUS_REQUEST_FAILED) {
            // Per fail-loud policy: log + Sentry (AuntieLog.w sends Sentry.captureMessage)
            // but do NOT throw - the call should still proceed; user just won't get
            // ducking of other apps.
            AuntieLog.w("AudioFocus request FAILED - call will proceed without ducking")
        } else {
            audioFocusRequest = req
        }
    }

    private fun releaseAudioFocus() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioFocusRequest?.let { am.abandonAudioFocusRequest(it) }
        audioFocusRequest = null
        // API 31+ setCommunicationDevice selections persist for the audio policy
        // lifetime. Without clearing, the next media playback or system Bluetooth
        // route can stay wedged on the wrong device until process restart.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                am.clearCommunicationDevice()
            } catch (e: Exception) {
                AuntieLog.w("clearCommunicationDevice failed; audio routing may persist until next process restart", e)
            }
        }
        am.mode = priorMode
    }

    override fun onDestroy() {
        releaseAudioFocus()
        super.onDestroy()
    }

    private fun showForegroundNotification() {
        val notification = NotificationCompat.Builder(this, AuntieOSApp.CALL_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Call in progress")
            .setContentText("Tribe Tails call connected")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .build()

        // API 34+ (Android 14) requires the type bitmask on startForeground for
        // services declared with `foregroundServiceType` in the manifest. Calling
        // the 2-arg overload throws MissingForegroundServiceTypeException at
        // runtime, crashing the call. The manifest type attribute alone is
        // insufficient - the runtime call must also pass the matching mask.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val type = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            startForeground(ONGOING_NOTIF_ID, notification, type)
        } else {
            startForeground(ONGOING_NOTIF_ID, notification)
        }
    }

    companion object {
        const val ACTION_START     = "com.tribetails.auntieos.CALL_SERVICE_START"
        const val ACTION_STOP      = "com.tribetails.auntieos.CALL_SERVICE_STOP"
        const val ONGOING_NOTIF_ID = 1003

        fun start(context: Context) {
            val intent = Intent(context, IncomingCallNotificationService::class.java)
                .apply { action = ACTION_START }
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, IncomingCallNotificationService::class.java)
                .apply { action = ACTION_STOP }
            context.startService(intent)
        }
    }
}
