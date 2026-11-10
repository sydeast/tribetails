package com.kinfolk.portal.push

import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.tasks.await

actual val pushPlatform: String = "android-mytribe"

/**
 * Android FCM token. No permission prompt here: fetching a token does not
 * require POST_NOTIFICATIONS (only displaying does). That permission is asked
 * from the Enable card through the notification permission gate (#1788).
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
} catch (c: CancellationException) {
    throw c
} catch (t: Throwable) {
    // The FCM failure code rides in the cause's message (SERVICE_NOT_AVAILABLE,
    // TOO_MANY_REGISTRATIONS, ...), so the class and message go in the line itself.
    val cause = t.cause ?: t
    Log.w("KinfolkPush", "FCM getToken failed: ${t::class.simpleName}: ${t.message} (cause ${cause::class.simpleName}: ${cause.message})", t)
    // #1787: rethrown, not turned into null, so the coordinator can tell a failed
    // token fetch (shown with a Retry on Notification Settings) from a platform
    // that has no token to give.
    throw t
}
