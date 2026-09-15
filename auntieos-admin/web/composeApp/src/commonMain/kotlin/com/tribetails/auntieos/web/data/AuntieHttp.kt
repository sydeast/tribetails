package com.tribetails.auntieos.web.data

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig

/**
 * #867: the time a connection may take to open. A dead network or an unreachable
 * host fails inside this, so the operator sees an error instead of a frozen screen.
 */
const val AUNTIE_CONNECT_TIMEOUT_MS: Long = 15_000L

/**
 * #867: the time a whole request may take once it is sent. 2nd-gen functions
 * default to a 60 second limit, and a cold start adds to that. A call to a function
 * that declares a longer limit asks for more per request (see
 * `callableRequestTimeoutMs` on desktop).
 */
const val AUNTIE_REQUEST_TIMEOUT_MS: Long = 90_000L

/** #867: what a screen shows when a request ran out of time. */
const val AUNTIE_TIMEOUT_MESSAGE: String = "Timed out reaching the server. Check your connection and try again."

/** #867: true when this throwable, not its causes, is a connect, socket or request timeout on this platform. */
internal expect fun Throwable.isTransportTimeout(): Boolean

/**
 * #867: the message to show for a failed request. A timeout anywhere in the cause
 * chain reads as [AUNTIE_TIMEOUT_MESSAGE]; anything else keeps its own message.
 * Common code, so the n8n client maps a timeout the same way the REST layer does.
 */
internal fun Throwable.transportMessage(fallback: String): String {
    var cursor: Throwable? = this
    var depth = 0
    while (cursor != null && depth < 8) {
        if (cursor.isTransportTimeout()) return AUNTIE_TIMEOUT_MESSAGE
        cursor = cursor.cause
        depth++
    }
    return message ?: fallback
}

/**
 * #867: every HTTP client the admin console builds comes from here, so every one
 * of them has connect and request timeouts, and on desktop every one of them is
 * covered by the test network guard.
 */
internal expect fun auntieHttpClient(
    requestTimeoutMs: Long = AUNTIE_REQUEST_TIMEOUT_MS,
    block: HttpClientConfig<*>.() -> Unit = {},
): HttpClient
