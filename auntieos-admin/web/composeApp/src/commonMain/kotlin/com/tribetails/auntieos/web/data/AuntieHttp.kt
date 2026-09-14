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

/**
 * #867: every HTTP client the admin console builds comes from here, so every one
 * of them has connect and request timeouts, and on desktop every one of them is
 * covered by the test network guard.
 */
internal expect fun auntieHttpClient(
    requestTimeoutMs: Long = AUNTIE_REQUEST_TIMEOUT_MS,
    block: HttpClientConfig<*>.() -> Unit = {},
): HttpClient
