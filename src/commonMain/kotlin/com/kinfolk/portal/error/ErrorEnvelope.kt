package com.kinfolk.portal.error

import kotlin.random.Random

data class ErrorEnvelope(
    val userMessage: String,
    val clientErrorId: String,
) {
    companion object {
        private const val OPAQUE = "An error occurred. It's been reported to Auntie."
        fun opaque(@Suppress("UNUSED_PARAMETER") cause: Throwable? = null): ErrorEnvelope {
            return ErrorEnvelope(OPAQUE, generateId())
        }
        /**
         * Wrap a known-safe message users should see verbatim (e.g. validation
         * "Email is required."). Use when the cause is a user-side mistake, not a
         * system fault.
         */
        fun message(text: String): ErrorEnvelope = ErrorEnvelope(text, generateId())
        private fun generateId(): String {
            val chars = "0123456789abcdef"
            return buildString { repeat(12) { append(chars[Random.nextInt(chars.length)]) } }
        }
    }
}
