package com.tribetails.auntieos.util

import android.util.Log
import io.sentry.Sentry
import io.sentry.SentryLevel

object AuntieLog {
    private const val TAG = "AuntieOS"

    /**
     * Redact a phone number for logging. Phone numbers ship to Sentry via
     * breadcrumbs + captured events; raw PII in dev logs is a GDPR exposure.
     * Returns `***<last4>` so dev can still correlate without leaking the number.
     */
    fun redactPhone(phone: String?): String {
        if (phone.isNullOrBlank()) return "<empty>"
        val tail = phone.takeLast(4)
        return "***$tail"
    }

    /**
     * Redact a personal-name field. Names alone aren't keys but combined with
     * a phone fragment they're identifiable. Use kinfolkId for correlation
     * when both are available.
     */
    fun redactName(name: String?): String {
        if (name.isNullOrBlank()) return "<anon>"
        return "<name>"
    }

    fun d(message: String) {
        Log.d(TAG, message)
        Sentry.addBreadcrumb(message)
    }

    fun i(message: String) {
        Log.i(TAG, message)
        Sentry.addBreadcrumb(message)
    }

    fun w(message: String, throwable: Throwable? = null) {
        if (isCoroutineCancellation(throwable)) return cancelled(message, throwable)
        Log.w(TAG, message, throwable)
        report(message, throwable, SentryLevel.WARNING)
    }

    fun e(message: String, throwable: Throwable? = null) {
        if (isCoroutineCancellation(throwable)) return cancelled(message, throwable)
        Log.e(TAG, message, throwable)
        report(message, throwable, SentryLevel.ERROR)
    }

    /**
     * #1067 / AUNTIEOS-ADMIN-1X / AUNTIEOS-ADMIN-1Z: a coroutine that was
     * cancelled (a `LaunchedEffect` or `rememberCoroutineScope` leaving the
     * composition, a ViewModel cleared) did not fail. It is logged at debug so
     * it is still visible in logcat, and never reported to Sentry, not even as
     * a breadcrumb: it happens on every navigation and would drown the trail.
     */
    private fun cancelled(message: String, throwable: Throwable?) {
        Log.d(TAG, "$message (cancelled: ${throwable?.javaClass?.simpleName})")
    }

    /**
     * What [w]/[e] do with a throwable, as a pure decision so it is unit
     * testable without the Android logger or a live Sentry hub.
     */
    internal enum class Disposition { DROP, BREADCRUMB, MESSAGE, EXCEPTION }

    internal fun dispositionFor(throwable: Throwable?): Disposition = when {
        throwable == null -> Disposition.MESSAGE
        isCoroutineCancellation(throwable) -> Disposition.DROP
        // #1066: signed out, or a credential that must be re-entered. The
        // sign-in screen handles it; see isExpectedAuthState.
        isTransportFailure(throwable) || isFcmUnavailable(throwable) ||
            isExpectedAuthState(throwable) -> Disposition.BREADCRUMB
        else -> Disposition.EXCEPTION
    }

    /**
     * AUNTIEOS-ADMIN-19 / AUNTIEOS-ADMIN-W: a transport failure (device offline,
     * cannot reach our servers) or an FCM/Play-Services "push isn't available on
     * this device" failure is not an application defect, so it does not get a
     * Sentry error event: that would report every offline read as a bug for as
     * long as the device stays offline. It still gets a breadcrumb, carrying the
     * exception's own class and message, so it is visible on the timeline of a
     * *real* error reported moments later from the same session.
     */
    private fun report(message: String, throwable: Throwable?, level: SentryLevel) {
        when (dispositionFor(throwable)) {
            Disposition.DROP -> Unit
            Disposition.MESSAGE -> Sentry.captureMessage(message, level)
            Disposition.BREADCRUMB -> Sentry.addBreadcrumb(
                "$message (${throwable?.javaClass?.simpleName}: ${throwable?.message})"
            )
            Disposition.EXCEPTION -> Sentry.captureException(throwable!!)
        }
    }
}
