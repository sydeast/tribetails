package com.kinfolk.portal.auth

/** What a code really is, read without using it. */
data class ActionCodeInfo(
    /** One of the `EmailAction.OP_*` constants. */
    val operation: String,
    val email: String?,
    val previousEmail: String? = null,
)

/**
 * Thrown by an auth backend that cannot check or apply email action codes.
 * Desktop's REST backend is the one (its transport belongs to PR #904). The
 * screen answers it with "Open this link in a web browser", and nothing else
 * happens: no password is set and no incident is filed.
 */
class EmailActionUnsupportedException : UnsupportedOperationException(
    "This device can't complete email links.",
)

/**
 * The auth calls the email action screen needs, kept narrow so the controller
 * can be tested with a small fake.
 */
interface EmailActionAuth {
    suspend fun readActionCode(oobCode: String): ActionCodeInfo
    suspend fun confirmPasswordReset(oobCode: String, newPassword: String)
    suspend fun applyActionCode(oobCode: String)

    /**
     * "Send a new link". Goes through [AuthRepository.sendPasswordReset], which
     * since #905 is our `requestPasswordReset` callable on every client. It
     * answers the same for an address that is and is not an account, so this
     * reports Sent either way. The server picks where the new link continues,
     * matching portal web's `sendReset(email)`.
     */
    suspend fun sendPasswordReset(email: String)

    /** The platform's auth error code for [t]; see [platformAuthErrorCode]. */
    fun errorCodeOf(t: Throwable): String? = platformAuthErrorCode(t)
}

/** Adapts [AuthRepository] to [EmailActionAuth]. */
fun AuthRepository.emailActionAuth(): EmailActionAuth {
    val repo = this
    return object : EmailActionAuth {
        override suspend fun readActionCode(oobCode: String) = repo.readActionCode(oobCode)
        override suspend fun confirmPasswordReset(oobCode: String, newPassword: String) =
            repo.confirmPasswordReset(oobCode, newPassword)
        override suspend fun applyActionCode(oobCode: String) = repo.applyActionCode(oobCode)
        override suspend fun sendPasswordReset(email: String) = repo.sendPasswordReset(email)
    }
}
