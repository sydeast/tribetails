package com.kinfolk.portal.push

import kotlin.js.Promise
import kotlinx.browser.window
import kotlinx.coroutines.await

actual val pushPlatform: String = "web-mytribe"

/**
 * Web Push (VAPID) application server key for project auntieos-ttpc.
 *
 * OPERATOR SECRET — not yet provisioned anywhere in this repo. Paste the
 * public key from: Firebase console > Project settings > Cloud Messaging >
 * Web Push certificates (key pair) for auntieos-ttpc.
 *
 * Until it is set, obtainPushToken() logs once and returns null — the web
 * portal simply runs without push, nothing crashes.
 */
object FirebaseWebPush {
    const val VAPID_KEY: String = "BAlfcLT9_cF4Bvd-VSFQkrNIKoKvLXSYuC5zP_Rq2L4l1IRsXBIafs3sOZji8E-uidHRbQhKRWcvAamMV5s12M4"
    val isConfigured: Boolean get() = !VAPID_KEY.startsWith("REPLACE_WITH")
}

private var foregroundHandlerInstalled = false

/**
 * Web FCM token flow. Only ever invoked by PushRegistrationCoordinator after
 * auth resolves to SignedIn, so the Notification permission prompt cannot
 * appear on first paint. Returns null (never throws) when:
 *  - VAPID key placeholder not replaced,
 *  - browser lacks Notification / push support (e.g. iOS Safari non-PWA),
 *  - permission already denied (silent — we never re-prompt a denial),
 *  - the user dismisses/denies the prompt,
 *  - the app service worker is not registered (boot.js failed).
 *
 * Worker decision: we REUSE the existing app shell worker
 * (resources/service-worker.js, registered by boot.js) instead of the
 * SDK-default /firebase-messaging-sw.js — its registration is passed to
 * getToken via serviceWorkerRegistration, and the worker handles the raw
 * 'push' event itself, keeping the firebase bundle out of the worker.
 */
actual suspend fun obtainPushToken(): String? {
    try {
        if (!FirebaseWebPush.isConfigured) {
            console.warn("[Push] VAPID key not configured (FirebaseWebPush.VAPID_KEY); web push disabled")
            return null
        }
        if (!(js("typeof Notification !== 'undefined'") as Boolean)) return null
        if (!isSupported().await()) return null

        when (js("Notification.permission") as String) {
            "denied" -> return null
            "granted" -> Unit
            else -> {
                val result = js("Notification.requestPermission()")
                    .unsafeCast<Promise<String>>().await()
                if (result != "granted") return null
            }
        }

        // boot.js registers service-worker.js on window load, long before any
        // sign-in completes. getRegistration() (not .ready) so a failed
        // registration returns null instead of suspending forever.
        val swReg: dynamic = window.navigator.serviceWorker.getRegistration().await()
        if (swReg == null) {
            console.warn("[Push] no service worker registration; web push disabled")
            return null
        }

        val messaging = getMessaging(getApp())
        val options: dynamic = js("({})")
        options.vapidKey = FirebaseWebPush.VAPID_KEY
        options.serviceWorkerRegistration = swReg
        val token = getToken(messaging, options).await()

        installForegroundHandler(messaging, swReg)
        return token.takeIf { it.isNotBlank() }
    } catch (t: Throwable) {
        console.warn("[Push] obtainPushToken failed: ${t.message ?: t}")
        return null
    }
}

/**
 * Foreground messages: surfaces a system notification, mirroring the Android
 * KinfolkFcmService behavior (the portal has no in-app toast surface for
 * catalog pushes yet). The notification `tag` is the fcmMessageId, the same
 * tag the service worker 'push' handler uses — so if both paths fire for one
 * message the second showNotification replaces the first instead of
 * duplicating.
 */
private fun installForegroundHandler(messaging: dynamic, swReg: dynamic) {
    if (foregroundHandlerInstalled) return
    foregroundHandlerInstalled = true
    onMessage(messaging) { payload ->
        try {
            val title = (payload?.notification?.title ?: payload?.data?.title) as? String ?: "MyTribe"
            val body = (payload?.notification?.body ?: payload?.data?.body) as? String ?: ""
            val options: dynamic = js("({})")
            options.body = body
            options.icon = "/icon-192.png"
            val tag = (payload?.fcmMessageId ?: payload?.data?.notificationKey) as? String
            if (tag != null) options.tag = tag
            val route = payload?.data?.route as? String
            val data: dynamic = js("({})")
            data.route = route
            options.data = data
            swReg.showNotification(title, options)
        } catch (t: Throwable) {
            console.warn("[Push] foreground message handling failed: ${t.message ?: t}")
        }
    }
}
