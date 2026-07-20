package com.tribetails.auntieos.fcm

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.app.NotificationCompat
import com.tribetails.auntieos.BuildConfig
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.R
import com.tribetails.auntieos.ui.calls.CallScreenActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class AuntieFirebaseMessagingService : FirebaseMessagingService() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)

        // Catalog-dispatched push (MyTribe notification subsystem) - identified by
        // `data.notificationKey` presence. Title/body live in remoteMessage.notification,
        // optional deep-link in `data.route`. Auto-IDs so multiple notification types
        // don't collide on the existing fixed slots (SMS/voicemail/booking).
        val catalogKey = remoteMessage.data["notificationKey"]
        if (catalogKey != null) {
            val title = remoteMessage.notification?.title
                ?: remoteMessage.data["title"]
                ?: catalogKey
            val body = remoteMessage.notification?.body
                ?: remoteMessage.data["body"]
                ?: ""
            val route = remoteMessage.data["route"]
            showMessageNotification(
                title = title,
                body = body,
                notificationId = NOTIFICATION_ID_CATALOG_BASE + (catalogKey.hashCode() and 0xFFFF),
                action = ACTION_OPEN_CATALOG_NOTIFICATION,
                extras = buildMap {
                    put(EXTRA_CATALOG_KEY, catalogKey)
                    if (route != null) put(EXTRA_CATALOG_ROUTE, route)
                }
            )
            return
        }

        when (remoteMessage.data["type"]) {
            "call_invite" -> {
                val callSid = remoteMessage.data["callSid"]
                val callerNumber = remoteMessage.data["callerNumber"]
                val transcript = remoteMessage.data["transcript"]
                showCallNotification(callSid, callerNumber, transcript)
            }
            "callback_request" -> {
                // Personal-line screened call. Caller chose press-3 (callback) over press-4 (VM).
                // No SDK leg, no ring - just a high-priority notification with tap-to-dial-out
                // back to the caller via the system dialer.
                val callerNumber = remoteMessage.data["callerNumber"] ?: "Unknown"
                val transcript   = remoteMessage.data["transcript"] ?: ""
                val line         = remoteMessage.data["line"] ?: "personal"
                showCallbackRequestNotification(callerNumber, transcript, line)
            }
            "sms_inbound" -> {
                val from = remoteMessage.data["from"] ?: "Unknown"
                val body = remoteMessage.data["body"] ?: ""
                showMessageNotification(
                    title = "New SMS from $from",
                    body = body,
                    notificationId = NOTIFICATION_ID_SMS,
                    action = ACTION_OPEN_MESSAGE,
                    extras = mapOf("from" to from, "body" to body)
                )
            }
            "voicemail" -> {
                val from = remoteMessage.data["from"]
                    ?: remoteMessage.data["callerNumber"]
                    ?: "Unknown"
                val playUrl = remoteMessage.data["playUrl"] ?: ""
                val line    = remoteMessage.data["line"]
                showMessageNotification(
                    title = FcmTitleHelper.voicemailTitle(from, line),
                    body = "Tap to listen",
                    notificationId = NOTIFICATION_ID_VOICEMAIL,
                    action = ACTION_OPEN_VOICEMAIL,
                    extras = mapOf("from" to from, EXTRA_PLAY_URL to playUrl)
                )
            }
            "booking_update" -> {
                val kinfolkName = remoteMessage.data["kinfolkName"] ?: ""
                val bookingStatus = remoteMessage.data["status"] ?: ""
                showMessageNotification(
                    title = "Booking Update",
                    body = "$kinfolkName - $bookingStatus",
                    notificationId = NOTIFICATION_ID_BOOKING,
                    action = Intent.ACTION_MAIN,
                    extras = mapOf("bookingId" to (remoteMessage.data["bookingId"] ?: ""))
                )
            }
            else -> Log.w("AuntieFCM", "Unrecognized FCM type: ${remoteMessage.data["type"]}")
        }
    }

    private fun showMessageNotification(
        title: String,
        body: String,
        notificationId: Int,
        action: String,
        extras: Map<String, String> = emptyMap()
    ) {
        val intent = Intent(this, com.tribetails.auntieos.MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            this.action = action
            extras.forEach { (k, v) -> putExtra(k, v) }
        }
        val pendingIntent = PendingIntent.getActivity(
            this, notificationId, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, AuntieOSApp.MESSAGE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()

        try {
            NotificationManagerCompat.from(this).notify(notificationId, notification)
        } catch (e: SecurityException) {
            Log.e("AuntieFCM", "Notification permission missing", e)
        }
    }

    private fun showCallbackRequestNotification(
        callerNumber: String,
        transcript: String,
        line: String,
    ) {
        // Tap → system dialer pre-populated with caller's #. User completes the outbound dial
        // from their PC SIM normally. No CALL_PHONE permission required (ACTION_DIAL only).
        val dialIntent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:$callerNumber")).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val dialPending = PendingIntent.getActivity(
            this, NOTIFICATION_ID_CALLBACK_REQUEST, dialIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val title = FcmTitleHelper.callbackRequestTitle(callerNumber, line)
        val body  = transcript.ifBlank { "Caller did not state a reason" }

        val notification = NotificationCompat.Builder(this, AuntieOSApp.CALL_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(dialPending)
            .setAutoCancel(true)
            .build()

        try {
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID_CALLBACK_REQUEST, notification)
        } catch (e: SecurityException) {
            Log.e("AuntieFCM", "Notification permission missing for callback request", e)
        }
    }

    private fun showCallNotification(callSid: String?, callerNumber: String?, transcript: String?) {
        // Create the intent to launch your Screening Activity
        val fullScreenIntent = Intent(this, CallScreenActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_CALL_SID, callSid)
            putExtra(EXTRA_CALLER_NUMBER, callerNumber)
            putExtra(EXTRA_TRANSCRIPT, transcript)
        }

        val fullScreenPendingIntent = PendingIntent.getActivity(
            this, 0, fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, AuntieOSApp.CALL_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Incoming Call")
            .setContentText(callerNumber)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setAutoCancel(true)
            .build()

        try {
            NotificationManagerCompat.from(this).notify(1, notification)
        } catch (e: SecurityException) {
            Log.e("AuntieFCM", "Notification permission missing")
        }
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        // NOTE-43: gate logging on DEBUG and truncate to avoid leaking full FCM token.
        // Mirrors MainActivity.kt refreshFcmToken() which already uses token.take(10).
        if (BuildConfig.DEBUG) Log.d("AuntieFCM", "New token: ${token.take(10)}...")
        serviceScope.launch {
            AuntieOSApp.instance.repository.saveDeviceToken(token)
        }
    }

    companion object {
        const val ACTION_OPEN_CALL = "com.tribetails.auntieos.OPEN_CALL"
        const val ACTION_OPEN_VOICEMAIL = "com.tribetails.auntieos.OPEN_VOICEMAIL"
        const val ACTION_OPEN_MESSAGE = "com.tribetails.auntieos.OPEN_MESSAGE"
        const val ACTION_OPEN_CATALOG_NOTIFICATION = "com.tribetails.auntieos.OPEN_CATALOG_NOTIFICATION"

        const val EXTRA_CALL_SID = "CALL_SID"
        const val EXTRA_CALLER_NUMBER = "CALLER_NUMBER"
        const val EXTRA_TRANSCRIPT = "TRANSCRIPT"
        const val EXTRA_POPUP_URL = "POPUP_URL"
        const val EXTRA_PLAY_URL = "PLAY_URL"
        const val EXTRA_CATALOG_KEY = "CATALOG_KEY"
        const val EXTRA_CATALOG_ROUTE = "CATALOG_ROUTE"

        private const val NOTIFICATION_ID_SMS = 2001
        private const val NOTIFICATION_ID_VOICEMAIL = 2002
        private const val NOTIFICATION_ID_BOOKING = 2003
        private const val NOTIFICATION_ID_CALLBACK_REQUEST = 2004
        // Catalog-dispatched notifications use IDs in [3000, 68536) - derived from
        // the catalog key hash, low 16 bits + offset. Prevents collision across
        // different catalog keys while still bucketing per notification type.
        private const val NOTIFICATION_ID_CATALOG_BASE = 3000
    }
}
