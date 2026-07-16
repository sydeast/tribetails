package com.kinfolk.portal.auth

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pure classifier tests for the reCAPTCHA-missing rejection (Identity Toolkit
 * HTTP 503 "Error code: 47") that gates the transparent sign-in retry.
 */
class RecaptchaReadyTest {

    @Test
    fun matchesErrorCode47() {
        assertTrue(isRecaptchaMissingError("Error code: 47"))
        assertTrue(isRecaptchaMissingError("Identity Toolkit rejected: Error code: 47 (missing token)"))
    }

    @Test
    fun matches503Marker() {
        assertTrue(isRecaptchaMissingError("HTTP error 503"))
        assertTrue(isRecaptchaMissingError("Firebase: Error (auth/internal-error) 503 Service Unavailable"))
    }

    @Test
    fun rejectsOtherMessages() {
        assertFalse(isRecaptchaMissingError(null))
        assertFalse(isRecaptchaMissingError(""))
        assertFalse(isRecaptchaMissingError("auth/wrong-password"))
        assertFalse(isRecaptchaMissingError("Error code: 17"))
        assertFalse(isRecaptchaMissingError("network request failed (400)"))
    }

    @Test
    fun timeoutConstant_isBounded() {
        // Sign-in must never wait unbounded on a hung init.
        assertTrue(RECAPTCHA_READY_TIMEOUT_MS in 1_000..30_000)
    }
}
