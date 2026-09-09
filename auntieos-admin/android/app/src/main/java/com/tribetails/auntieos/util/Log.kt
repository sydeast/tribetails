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
        Log.w(TAG, message, throwable)
        report(message, throwable, SentryLevel.WARNING)
    }

    fun e(message: String, throwable: Throwable? = null) {
        Log.e(TAG, message, throwable)
        report(message, throwable, SentryLevel.ERROR)
    }

    /**
     * AUNTIEOS-ADMIN-19 / AUNTIEOS-ADMIN-W: a transport failure (device offline,
     * cannot reach our servers) or an FCM/Play-Services "push isn't available on
     * this device" failure is not an application defect, so it does not get a
     * Sentry error event — that would report every offline read as a bug for as
     * long as the device stays offline. It still gets a breadcrumb, carrying the
     * exception's own class and message, so it is visible on the timeline of a
     * *real* error reported moments later from the same session.
     */
    private fun report(message: String, throwable: Throwable?, level: SentryLevel) {
        when {
            throwable == null -> Sentry.captureMessage(message, level)
            isTransportFailure(throwable) || isFcmUnavailable(throwable) -> {
                Sentry.addBreadcrumb(
                    "$message (${throwable.javaClass.simpleName}: ${throwable.message})"
                )
            }
            else -> Sentry.captureException(throwable)
        }
    }
}
