package com.kinfolk.portal.push

actual val pushPlatform: String = "desktop-mytribe"

/**
 * Desktop JVM: platform-unsupported by design. There is no FCM client SDK for
 * desktop JVM (gitlive on JVM is the Admin SDK, and the REST shim has no
 * device-token concept), so push registration is skipped entirely — the
 * coordinator treats a null token as "no push on this platform".
 */
actual suspend fun obtainPushToken(): String? {
    println("[Push] desktop JVM has no FCM client; skipping push registration")
    return null
}
