package com.kinfolk.portal.auth

/**
 * #886: this platform's Firebase Auth error code for a failed sign-in, or null
 * when [t] carries none (a network exception, a test fake).
 *
 * Android reads the native `FirebaseAuthException.errorCode` (`ERROR_WRONG_PASSWORD`),
 * web reads the JS SDK's `auth/...` code out of the message, and desktop reads
 * the Identity Toolkit REST error (`INVALID_LOGIN_CREDENTIALS`). The one rule
 * that decides what counts is [classifySignInFailure].
 */
expect fun platformAuthErrorCode(t: Throwable): String?
