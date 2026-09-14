package com.kinfolk.portal.auth

/**
 * gitlive's `FirebaseAuthException` is the native Android class on this
 * platform, so its `errorCode` separates `ERROR_USER_NOT_FOUND` from
 * `ERROR_USER_DISABLED`, which share `FirebaseAuthInvalidUserException`.
 */
actual fun platformAuthErrorCode(t: Throwable): String? =
    (t as? dev.gitlive.firebase.auth.FirebaseAuthException)?.errorCode
