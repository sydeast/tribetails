package com.kinfolk.portal.auth

/**
 * Cross-platform HTTP client for the public `confirmSecureReset` Cloud Function.
 *
 * The user is signed-out when hitting this flow, so we cannot use
 * [com.kinfolk.portal.firebase.FunctionsClient] (which requires auth).
 *
 * Fail-loud: errors throw [SecureResetException] so the UI renders a visible
 * banner. Do NOT silently swallow.
 *
 * Platform implementations:
 *   jsMain   — uses `window.fetch`
 *   jvmMain  — uses Ktor CIO
 *   android  — uses Ktor CIO (same as jvmMain via shared source or copy)
 */
interface SecureResetFetcher {
    /**
     * POSTs to `confirmSecureReset` with the oobCode + new password.
     *
     * @param oobCode     Firebase oobCode from the reset link.
     * @param newPassword New password chosen by the kinfolk (min 8 chars).
     * @param email       Kinfolk email (for the audit record).
     * @param userAgent   Browser/device user-agent string (best-effort).
     * @return            Firestore incident ID on success.
     * @throws SecureResetException on any failure.
     */
    suspend fun confirmReset(
        oobCode: String,
        newPassword: String,
        email: String,
        userAgent: String,
    ): String
}

expect fun makeSecureResetFetcher(
    base: String = DEFAULT_SECURE_RESET_BASE,
): SecureResetFetcher

const val DEFAULT_SECURE_RESET_BASE = "https://us-central1-auntieos-ttpc.cloudfunctions.net"

class SecureResetException(message: String) : RuntimeException(message)
