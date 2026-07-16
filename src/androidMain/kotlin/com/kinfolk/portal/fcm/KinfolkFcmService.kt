package com.kinfolk.portal.fcm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.kinfolk.portal.MainActivity

/**
 * MyTribe (kinfolk) Android FCM service.
 *
 * Token lifecycle (split with common push/PushRegistrationCoordinator):
 *   - onNewToken → if signed in, calls registerFcmToken(token, "android-mytribe").
 *     If not signed in, registration is skipped here — the common
 *     PushRegistrationCoordinator (wired in KinfolkPortalAppGuarded) registers
 *     the current token once auth resolves, via push/PushToken.android.kt.
 *     Disjoint trigger events (rotation here, sign-in there) + the server's
 *     fcm_tokens/{token} upsert mean no double registration.
 *
 * Message handling:
 *   - Catalog-dispatched (`data.notificationKey` present) → posts a system
 *     notification with title/body from the FCM notification payload.
 *     `data.route` optionally carries a deep-link route for tap handling.
 *   - Other types → logs and drops (kinfolk app currently has no Twilio/SMS flow).
 *
 * Fail-loud per project policy: registration failures log to Sentry-eligible
 * Android Log.w; never silently swallowed.
 */
class KinfolkFcmService : FirebaseMessagingService() {

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        val uid = FirebaseAuth.getInstance().currentUser?.uid
        if (uid == null) {
            Log.i(TAG, "FCM token issued before sign-in; will retry after auth")
            return
        }
        registerToken(token)
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        val catalogKey = remoteMessage.data["notificationKey"]
        if (catalogKey == null) {
            Log.w(TAG, "Unrecognized FCM message (no notificationKey): ${remoteMessage.data}")
            return
        }
        val title = remoteMessage.notification?.title
            ?: remoteMessage.data["title"]
            ?: catalogKey
        val body = remoteMessage.notification?.body
            ?: remoteMessage.data["body"]
            ?: ""
        val route = remoteMessage.data["route"]
        showCatalogNotification(catalogKey, title, body, route)
    }

    private fun registerToken(token: String) {
        try {
            val data = hashMapOf<String, Any>(
                "token" to token,
                "platform" to "android-mytribe",
            )
            FirebaseFunctions.getInstance().getHttpsCallable("registerFcmToken").call(data)
                .addOnFailureListener { Log.w(TAG, "registerFcmToken failed", it) }
        } catch (t: Throwable) {
            Log.w(TAG, "registerFcmToken threw", t)
        }
    }

    private fun showCatalogNotification(
        catalogKey: String,
        title: String,
        body: String,
        route: String?,
    ) {
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_CATALOG_KEY, catalogKey)
            if (route != null) putExtra(EXTRA_CATALOG_ROUTE, route)
        }
        val notificationId = NOTIFICATION_ID_BASE + (catalogKey.hashCode() and 0xFFFF)
        val pending = PendingIntent.getActivity(
            this,
            notificationId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_def_app_icon)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(this).notify(notificationId, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "POST_NOTIFICATIONS permission missing", e)
        }
    }

    companion object {
        private const val TAG = "KinfolkFcm"
        const val CHANNEL_ID = "mytribe-catalog"
        const val EXTRA_CATALOG_KEY = "CATALOG_KEY"
        const val EXTRA_CATALOG_ROUTE = "CATALOG_ROUTE"
        private const val NOTIFICATION_ID_BASE = 4000

        fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Updates",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = "Catalog-dispatched notifications from your Auntie business."
                },
            )
        }
    }
}
