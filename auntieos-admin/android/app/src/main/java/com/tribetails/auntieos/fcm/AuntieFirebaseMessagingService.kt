package com.tribetails.auntieos.fcm

import android.app.PendingIntent
import android.content.Context
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
import com.tribetails.auntieos.data.api.RetrofitClient
import com.tribetails.auntieos.ui.calls.CallScreenActivity
import com.tribetails.auntieos.voice.CallInviteManager
import com.tribetails.auntieos.voice.VoiceTokenManager
import com.twilio.voice.CallException
import com.twilio.voice.CallInvite
import com.twilio.voice.CancelledCallInvite
import com.twilio.voice.MessageListener
import com.twilio.voice.Voice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Two completely different pushes can announce the same incoming call, and
 * mixing them up is why the app went so long without ever ringing:
 *
 *  1. The TWILIO VOICE SDK push. Sent by Twilio itself to the FCM token that
 *     [VoiceTokenManager] registered. Its data payload carries `twi_message_type`
 *     and a pile of other `twi_*` keys that only the SDK can decode. It MUST be
 *     handed to [Voice.handleMessage], which parses it and calls back with a
 *     [CallInvite]. That CallInvite is the only object able to accept or reject
 *     the call leg, so this push is the one that actually rings the phone.
 *
 *  2. The CUSTOM `type == "call_invite"` push. Sent by our own backend, with the
 *     human-readable context the SDK payload does not carry: callSid,
 *     callerNumber and the screening transcript. It raises the screening UI so
 *     the user can see WHO is calling and WHY.
 *
 * They are complementary, not alternatives: the SDK push rings, the custom push
 * explains. Both branches below must keep working.
 */
class AuntieFirebaseMessagingService : FirebaseMessagingService() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Bridge from the Voice SDK's parsed callbacks into [CallInviteManager],
     * which owns the invite the UI answers or rejects. Before this existed,
     * `activeInvite` was permanently null and answer()/reject() returned
     * immediately doing nothing.
     */
    private val voiceMessageListener = object : MessageListener {
        override fun onCallInvite(callInvite: CallInvite) {
            Log.d(TAG, "Voice SDK call invite for sid ${callInvite.callSid}")
            CallInviteManager.onCallInvite(callInvite)
        }

        override fun onCancelledCallInvite(
            cancelledCallInvite: CancelledCallInvite,
            callException: CallException?
        ) {
            // CallInviteManager takes no exception, so log it here rather than
            // dropping the only signal that a cancellation was an error.
            if (callException != null) {
                Log.w(TAG, "Cancelled call invite carried an error: ${callException.message}")
            }
            CallInviteManager.onCancelledCallInvite(cancelledCallInvite)
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)

        // Twilio Voice SDK push - checked FIRST because Twilio owns the shape of
        // this payload and we do not. Our own `type` / `notificationKey` routing
        // keys are ours to keep clear of it, not the other way round.
        if (isVoiceSdkPush(remoteMessage.data)) {
            handleVoiceSdkPush(remoteMessage.data)
            return
        }

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
                // OUR push, not Twilio's. Carries the screening context (who is
                // calling, what they said) and raises CallScreenActivity. It does
                // NOT create a Voice SDK call leg - the SDK push above does that.
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

    /**
     * Hands the raw data payload to the Voice SDK. The SDK decodes it and calls
     * back on [voiceMessageListener] - synchronously, in practice, which is why
     * no notification is raised here: the invite reaches CallInviteManager and
     * the UI reacts to its state flow.
     */
    private fun handleVoiceSdkPush(data: Map<String, String>) {
        val handled = try {
            voiceMessageHandler(applicationContext, data, voiceMessageListener)
        } catch (e: Exception) {
            Log.e(TAG, "Voice.handleMessage threw on a twi_message_type push", e)
            false
        }
        if (!handled) {
            // Do not fall through to the `type` routing: a Twilio payload has no
            // `type` key, so it would only land in the unrecognized branch.
            Log.w(
                TAG,
                "Voice SDK rejected a push with twi_message_type=${data[TWILIO_MESSAGE_TYPE_KEY]}"
            )
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
        // Per-call id, derived from the callSid, so a second incoming call does
        // not overwrite the first one's notification. This used to be notify(1,
        // ...) with a hardcoded literal while every sibling used a named
        // constant.
        val notificationId = callNotificationId(callSid)

        // Create the intent to launch your Screening Activity
        val fullScreenIntent = Intent(this, CallScreenActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_CALL_SID, callSid)
            putExtra(EXTRA_CALLER_NUMBER, callerNumber)
            putExtra(EXTRA_TRANSCRIPT, transcript)
        }

        // The request code must vary with the call too. With a fixed 0 and
        // FLAG_UPDATE_CURRENT both calls share one PendingIntent, so the second
        // call's extras overwrite the first call's - distinct notifications that
        // both open the same screening screen.
        val fullScreenPendingIntent = PendingIntent.getActivity(
            this, notificationId, fullScreenIntent,
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
            NotificationManagerCompat.from(this).notify(notificationId, notification)
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
        // A rotated FCM token invalidates the binding Twilio holds, so the Voice
        // SDK has to re-register or the SDK push above never arrives again.
        // Saving the token to our own backend is not enough on its own.
        try {
            VoiceTokenManager.onFcmTokenRefresh(
                applicationContext,
                RetrofitClient.buildTwilio(),
                token,
                serviceScope
            )
        } catch (e: Exception) {
            Log.e("AuntieFCM", "Voice SDK re-registration after token refresh failed", e)
        }
    }

    companion object {
        private const val TAG = "AuntieFCM"

        /**
         * Key Twilio puts in every Voice SDK data payload. Its presence, not our
         * `type` field, is what identifies a push the SDK must parse.
         */
        internal const val TWILIO_MESSAGE_TYPE_KEY = "twi_message_type"

        /**
         * Seam over [Voice.handleMessage]. Production always uses the real SDK
         * call; unit tests swap it so routing can be asserted without the Voice
         * SDK's native library. Signature matches the SDK's Map overload:
         * `handleMessage(Context, Map<String, String>, MessageListener): Boolean`.
         */
        internal var voiceMessageHandler: (Context, Map<String, String>, MessageListener) -> Boolean =
            { context, data, listener -> Voice.handleMessage(context, data, listener) }

        internal fun isVoiceSdkPush(data: Map<String, String>): Boolean =
            data.containsKey(TWILIO_MESSAGE_TYPE_KEY)

        /**
         * Distinct notification id per call, so two calls arriving close together
         * are two notifications instead of one overwriting the other. A missing
         * callSid falls back to the base, which is still its own reserved slot.
         */
        internal fun callNotificationId(callSid: String?): Int =
            NOTIFICATION_ID_CALL_BASE + ((callSid?.hashCode() ?: 0) and 0xFFFF)

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
        // Incoming-call notifications use IDs in [70000, 135536) - derived from
        // the callSid hash, low 16 bits + offset. Sits above the catalog range,
        // which tops out at 68535, so the two can never collide.
        internal const val NOTIFICATION_ID_CALL_BASE = 70000
    }
}
