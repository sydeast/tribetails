package com.tribetails.auntieos.util

import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseAuthInvalidUserException
import com.tribetails.auntieos.data.repository.AuthGate
import com.tribetails.auntieos.data.repository.SignInRequiredException

/**
 * True when [error] means "nobody is signed in" or "this session's credential
 * is no longer valid", anywhere in its cause chain (#1066).
 *
 * AUNTIEOS-ADMIN-1W / 1Y: on a cold start with a persisted user whose token
 * can no longer be refreshed, the callable SDK's context lookup fails with
 * `ExecutionException: 1 out of 2 underlying tasks failed` wrapping a
 * [FirebaseAuthInvalidUserException], and the next call hits
 * [AuthGate.ensureAuthenticated]. Both are the operator needing to sign in
 * again, which the app handles (`RevokedSessionGuard` signs out and the auth
 * state routes to sign-in). Neither is a defect, so [AuntieLog] keeps them to a
 * breadcrumb instead of a Sentry event.
 *
 * The chain is walked because nothing reaches a logger unwrapped: the Tasks
 * bridge, `runCatching`, and `AuthGate.requireTestMode` all wrap.
 */
fun isExpectedAuthState(error: Throwable?): Boolean {
    var cursor = error
    var depth = 0
    while (cursor != null && depth < 8) {
        when {
            cursor is SignInRequiredException -> return true
            cursor is FirebaseAuthInvalidUserException -> return true
            cursor is FirebaseAuthInvalidCredentialsException -> return true
            cursor is IllegalStateException && cursor.message == AuthGate.SIGN_IN_REQUIRED -> return true
        }
        // Guarded because this runs inside AuntieLog for EVERY reported
        // throwable, and a logger must never throw; a strict test double of a
        // Firebase exception, for one, has no `cause` to hand back.
        cursor = runCatching { cursor?.cause }.getOrNull()
        depth++
    }
    return false
}
