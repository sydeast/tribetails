package com.kinfolk.portal.auth

/**
 * Cross-platform HTTP client for the public `confirmSecureReset` Cloud Function.
 *
 * Only the explicit "I did not ask for this reset" choice on the email action
 * screen calls this (#892, #905). A normal reset never does: it sets the
 * password through the auth SDK and files no incident.
 *
 * The user is signed out on this flow, so it cannot use
 * [com.kinfolk.portal.firebase.FunctionsClient] (which requires auth).
 *
 * Errors throw [SecureResetException] carrying reader-facing copy, so the
 * screen shows it as it is.
 *
 * Platform implementations:
 *   android  HttpURLConnection, body from [secureResetPayload]
 *   jsMain   window.fetch, body from [secureResetPayload]
 *   jvmMain  Ktor, body from [secureResetPayload] too since #933 item 4
 *            (desktop never reaches this call, see [SecureResetController])
 */
interface SecureResetFetcher {
    /**
     * POSTs to `confirmSecureReset` with the oobCode and new password.
     *
     * @param oobCode     Firebase oobCode from the reset link.
     * @param newPassword New password (min 8 chars).
     * @param email       The address the verified code belongs to. No
     *                    implementation puts it on the wire: the server derives
     *                    the account from the code and has ignored a client-sent
     *                    address since #903, and all three bodies are
     *                    [secureResetPayload]. The parameter stays because the
     *                    interface is shared by three platforms and the screen
     *                    already holds the address; it is not a slot for a
     *                    future body to fill, since a request naming an account
     *                    is the thing #903 removed.
     * @param userAgent   Device user-agent string (best-effort).
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

/**
 * The request body: `oobCode`, `newPassword` and `userAgent`, and no email
 * (#892's contract, the same keys the web page posts).
 */
fun secureResetPayload(oobCode: String, newPassword: String, userAgent: String): String =
    """{"oobCode":${jsonString(oobCode)},"newPassword":${jsonString(newPassword)},"userAgent":${jsonString(userAgent)}}"""

/**
 * The incident id from a 200 body, or throws [SecureResetException] with copy
 * that says what went wrong and what to do. Status codes and error keys are the
 * ones `mytribe/functions/src/security/confirmSecureReset.ts` sends.
 */
fun secureResetResult(status: Int, body: String): String {
    if (status == 200) {
        return extractJsonStringField(body, "incidentId")
            ?: throw SecureResetException(
                "We couldn't confirm your account was secured. Try signing in with your new password.",
            )
    }
    throw SecureResetException(secureResetFailureMessage(status, body))
}

internal fun secureResetFailureMessage(status: Int, body: String): String {
    val error = extractJsonStringField(body, "error")
    val detail = extractJsonStringField(body, "detail")
    return when {
        status == 429 -> "Too many attempts for this account today. Try again tomorrow."
        status == 400 && error == "password_too_short" -> "Password needs at least 8 characters."
        status == 400 && error == "missing_required" -> "Type a new password in both boxes, then try again."
        status == 400 && detail == "wrong_code_type" -> "This link can't be used to reset a password."
        status == 400 && error == "reset_failed" ->
            "This reset link has expired or has already been used. Go back and send a new link."
        status == 502 && error == "outcome_unknown" ->
            "We couldn't confirm your password changed. Try signing in with your new password. Tribe Tails has been alerted."
        status == 502 -> "We couldn't reach the sign-in service. Check your connection and try again."
        status == 503 -> "Securing accounts isn't available right now. Try again in a few minutes."
        else -> "We couldn't secure your account (error $status). Try again in a moment."
    }
}

private fun jsonString(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (ch in s) {
        when {
            ch == '\\' -> sb.append("\\\\")
            ch == '"' -> sb.append("\\\"")
            ch == '\n' -> sb.append("\\n")
            ch == '\r' -> sb.append("\\r")
            ch == '\t' -> sb.append("\\t")
            ch.code < 0x20 -> sb.append("\\u").append(ch.code.toString(16).padStart(4, '0'))
            else -> sb.append(ch)
        }
    }
    sb.append('"')
    return sb.toString()
}

/** A top-level string field from a small JSON object, without a parser dependency. */
internal fun extractJsonStringField(json: String, key: String): String? =
    Regex(""""${Regex.escape(key)}"\s*:\s*"([^"]*)"""").find(json)?.groupValues?.getOrNull(1)
