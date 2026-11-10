package com.kinfolk.portal.push

/**
 * Platform string recorded server-side in fcm_tokens/{token}.platform
 * (functions/src/portal/registerFcmToken.ts).
 *
 *   android → "android-mytribe" (matches KinfolkFcmService)
 *   js      → "web-mytribe"
 *   jvm     → "desktop-mytribe" (token is always null there; see actual)
 */
expect val pushPlatform: String

/**
 * Requests notification permission where the platform needs one, then returns
 * the FCM device token — or null when push is unavailable: permission denied,
 * browser unsupported, VAPID key not configured, or platform has no FCM client
 * (desktop JVM). A real failure to fetch a token may throw (Android does, #1787):
 * [PushRegistrationCoordinator] catches it, records it and offers a retry.
 * Implementations must never prompt for
 * permission on their own schedule — this is only called by
 * [PushRegistrationCoordinator.onSignedIn], i.e. after authentication.
 */
expect suspend fun obtainPushToken(): String?
