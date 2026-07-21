package com.tribetails.auntieos.ui.communicate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Stage 2 step 5: pure client-side validation of the Communicate external-send form.
 * Mirrors the server's sendExternalMessage gate so the operator gets immediate honest
 * feedback before a round-trip. Kept pure so it is testable without Compose/Firebase.
 */
class ExternalSendValidationTest {

    @Test fun `valid email send passes`() {
        assertNull(
            validateExternalSend(
                ExternalChannel.Email,
                to = "owner@example.com",
                subject = "A visit recap",
                body = "All went well.",
            ),
        )
    }

    @Test fun `valid sms send passes with no subject`() {
        assertNull(
            validateExternalSend(
                ExternalChannel.Sms,
                to = "(555) 123-4567",
                subject = "",
                body = "See you tomorrow.",
            ),
        )
    }

    @Test fun `blank recipient is rejected`() {
        assertEquals(
            "Recipient is required.",
            validateExternalSend(ExternalChannel.Email, "   ", "S", "B"),
        )
    }

    @Test fun `invalid email is rejected`() {
        assertEquals(
            "Enter a valid email address.",
            validateExternalSend(ExternalChannel.Email, "not-an-email", "S", "B"),
        )
    }

    @Test fun `email without subject is rejected`() {
        assertEquals(
            "Subject is required for email.",
            validateExternalSend(ExternalChannel.Email, "owner@example.com", "  ", "B"),
        )
    }

    @Test fun `invalid phone is rejected`() {
        assertEquals(
            "Enter a valid phone number.",
            validateExternalSend(ExternalChannel.Sms, "12345", "", "B"),
        )
    }

    @Test fun `blank body is rejected for email`() {
        assertEquals(
            "Message body is required.",
            validateExternalSend(ExternalChannel.Email, "owner@example.com", "S", "   "),
        )
    }

    @Test fun `blank body is rejected for sms`() {
        assertEquals(
            "Message body is required.",
            validateExternalSend(ExternalChannel.Sms, "(555) 123-4567", "", ""),
        )
    }

    @Test fun `sms ignores subject requirement`() {
        // subject blank but body present -> sendable
        assertNull(validateExternalSend(ExternalChannel.Sms, "5551234567", "", "Hi"))
    }

    @Test fun `channel wire values match the callable enum`() {
        assertEquals("email", ExternalChannel.Email.wire)
        assertEquals("sms", ExternalChannel.Sms.wire)
    }
}
