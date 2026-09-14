package com.kinfolk.portal.auth

import com.kinfolk.portal.firebase.FirebaseRestException

private val REST_ERROR_MESSAGE = Regex("\"message\"\\s*:\\s*\"([A-Z_]+)")

/**
 * Desktop signs in over Identity Toolkit REST, which fails with a body like
 * `{"error":{"code":400,"message":"INVALID_LOGIN_CREDENTIALS"}}` or
 * `"TOO_MANY_ATTEMPTS_TRY_LATER : ..."`. The leading upper-case token of the
 * first `message` is the code. Anything that is not a REST failure (an
 * IOException, a timeout) has none.
 */
actual fun platformAuthErrorCode(t: Throwable): String? {
    val body = (t as? FirebaseRestException)?.responseBody ?: return null
    return REST_ERROR_MESSAGE.find(body)?.groupValues?.get(1)
}
