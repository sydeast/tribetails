package com.tribetails.auntieos.ui.communicate

/**
 * Operator-readable text for a failed external send or opt-out.
 *
 * Communicate used to map nothing here. A suppressed recipient reached the
 * operator as the raw token `recipient_opted_out` in an error banner, while
 * Broadcast a few hundred lines away already had `broadcastErrorText` doing
 * exactly this job for its own two sentinels. The web twin is
 * `auntieos-admin/src/lib/externalSend.ts`, and the two now say the same words.
 *
 * Exactly one thing is translated. Every other failure passes through verbatim,
 * because a provider's own words ("smtp2go rejected the sender domain") tell the
 * operator far more than any sentence we could substitute, and hiding them
 * behind "Something went wrong" turns a fixable configuration problem into an
 * unfixable one.
 */

/**
 * The server throws `failed-precondition` with the literal message
 * `recipient_opted_out`. A substring test, not equality: the callable SDK
 * prefixes the code, and Android and web format that prefix differently.
 */
fun isOptedOutError(message: String?): Boolean =
    message?.contains("recipient_opted_out", ignoreCase = true) == true

fun externalSendErrorText(message: String?): String = when {
    isOptedOutError(message) ->
        "This recipient has opted out. Nothing was sent. Remove their suppression before sending again."
    message.isNullOrBlank() -> "The send failed."
    else -> message
}
