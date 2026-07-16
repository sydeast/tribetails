package com.kinfolk.portal.push

import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.tasks.await

actual val pushPlatform: String = "android-mytribe"

/**
 * Android FCM token. No permission prompt here: fetching a token does not
 * require POST_NOTIFICATIONS (only displaying does — KinfolkFcmService
 * already catches the SecurityException when it's missing).
 *
 * Split of responsibilities with KinfolkFcmService:
 *   - sign-in time registration → common PushRegistrationCoordinator via this
 *     actual (covers the first-install case where onNewToken fired pre-auth
 *     and was skipped);
 *   - mid-session token rotation → KinfolkFcmService.onNewToken registers
 *     directly. Both call the same upsert callable on disjoint events, so no
 *     double registration occurs.
 */
actual suspend fun obtainPushToken(): String? = try {
    FirebaseMessaging.getInstance().token.await()
} catch (t: Throwable) {
    Log.w("KinfolkPush", "FCM getToken failed", t)
    null
}
