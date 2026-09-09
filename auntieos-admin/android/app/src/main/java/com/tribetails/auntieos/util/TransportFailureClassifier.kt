package com.tribetails.auntieos.util

import com.google.firebase.functions.FirebaseFunctionsException
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * True when [error] is the device being offline or unable to reach our servers,
 * rather than a real defect in the app or the backend.
 *
 * AUNTIEOS-ADMIN-19: every dashboard read goes through [AuntieRepository] and
 * lands failures in [AuntieLog.e]/[AuntieLog.w], which reports every throwable
 * to Sentry. On a phone with no signal, a Firestore or callable read fails with
 * an `INTERNAL` (or `UNAVAILABLE`) [FirebaseFunctionsException] wrapping an
 * [UnknownHostException] or [SocketTimeoutException] against
 * `us-central1-auntieos-ttpc.cloudfunctions.net`. That fired a Sentry error on
 * every failed read for as long as the device stayed offline — indistinguishable
 * from a real backend defect, and loud enough to bury the errors that are real.
 * [AuntieLog] uses this to downgrade those to a breadcrumb; the app's existing
 * `isOffline` banner (see `HomeUiState`) is what should tell the user, not Sentry.
 *
 * A bare `INTERNAL` with no [IOException] cause is left alone: that is the
 * server actually throwing, not the network dropping the call.
 */
fun isTransportFailure(error: Throwable?): Boolean {
    if (error == null) return false
    return when (error) {
        is UnknownHostException, is SocketTimeoutException, is ConnectException -> true
        is FirebaseFunctionsException -> {
            when (error.code) {
                FirebaseFunctionsException.Code.UNAVAILABLE -> true
                FirebaseFunctionsException.Code.INTERNAL -> error.cause is IOException
                else -> false
            }
        }
        else -> false
    }
}

/**
 * True when [error] is FCM/Play-Services telling this device that push is not
 * available at all, rather than a bug in how we asked for a token.
 *
 * AUNTIEOS-ADMIN-W: on an AOSP emulator with no Play Services,
 * `FirebaseMessaging.getInstance().token` (and the legacy `FirebaseInstanceId`
 * path some Play-Services versions still route through) fails with a plain
 * `IOException("MISSING_INSTANCEID_SERVICE")`; `GmsRpc` reports the same
 * condition as `IOException("SERVICE_NOT_AVAILABLE")`. Neither is an
 * `UnknownHostException` or a timeout, so [isTransportFailure] does not catch
 * it, and neither is fixable by retrying — the device has no Instance ID
 * service to ask. `MainActivity.refreshFcmToken` and
 * `VoiceTokenManager.resolveFcmToken` use this to log and skip push
 * registration instead of reporting to Sentry.
 */
fun isFcmUnavailable(error: Throwable?): Boolean {
    if (error !is IOException) return false
    val message = error.message ?: return false
    return message.contains("MISSING_INSTANCEID_SERVICE") || message.contains("SERVICE_NOT_AVAILABLE")
}
