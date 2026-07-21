package com.tribetails.auntieos.web.screens.communicate

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Stage 2 step 5: pure validation + decode helpers for the Communicate external
 * send. These mirror the server's checks (sendExternalMessage.ts) so the operator
 * gets fail-loud feedback before a round-trip. Happy + sad + negative + decode.
 */
class ExternalSendTest {

    // ---- email validation ----

    @Test fun validEmailAccepted() {
        assertTrue(isValidExternalEmail("name@example.com"))
        assertTrue(isValidExternalEmail("  a.b+tag@sub.example.co  ")) // trimmed
    }

    @Test fun invalidEmailRejected() {
        assertFalse(isValidExternalEmail(""))
        assertFalse(isValidExternalEmail("nope"))
        assertFalse(isValidExternalEmail("no@domain"))      // no dotted host
        assertFalse(isValidExternalEmail("two@@example.com"))
        assertFalse(isValidExternalEmail("has space@example.com"))
    }

    // ---- phone validation ----

    @Test fun validPhoneAccepted() {
        assertTrue(isValidExternalPhone("+15551234567"))
        assertTrue(isValidExternalPhone("+1 (555) 123-4567"))
        assertTrue(isValidExternalPhone("5551234567"))
    }

    @Test fun invalidPhoneRejected() {
        assertFalse(isValidExternalPhone(""))
        assertFalse(isValidExternalPhone("123"))            // too few digits
        assertFalse(isValidExternalPhone("+1234567890123456")) // too many digits
        assertFalse(isValidExternalPhone("call-me"))        // letters
    }

    // ---- validateRecipient ----

    @Test fun validateRecipientPerChannel() {
        assertEquals(
            RecipientValidation.Valid("name@example.com"),
            validateRecipient(ExternalChannel.Email, " name@example.com "),
        )
        assertEquals(RecipientValidation.Empty, validateRecipient(ExternalChannel.Email, "   "))
        assertEquals(RecipientValidation.BadEmail, validateRecipient(ExternalChannel.Email, "nope"))
        assertEquals(
            RecipientValidation.Valid("+15551234567"),
            validateRecipient(ExternalChannel.Sms, " +15551234567 "),
        )
        assertEquals(RecipientValidation.BadPhone, validateRecipient(ExternalChannel.Sms, "123"))
    }

    // ---- whole-form blocker ----

    @Test fun emailReadyHasNoBlocker() {
        assertNull(externalSendBlocker(ExternalChannel.Email, "n@example.com", "Hi", "Body"))
    }

    @Test fun smsReadyIgnoresSubject() {
        // SMS does not require a subject.
        assertNull(externalSendBlocker(ExternalChannel.Sms, "+15551234567", "", "Body"))
    }

    @Test fun emailMissingSubjectBlocks() {
        assertEquals("Email needs a subject.", externalSendBlocker(ExternalChannel.Email, "n@example.com", "  ", "Body"))
    }

    @Test fun missingBodyBlocks() {
        assertEquals("Write a message body first.", externalSendBlocker(ExternalChannel.Email, "n@example.com", "Hi", "   "))
    }

    @Test fun badRecipientBlocksBeforeSubjectOrBody() {
        assertEquals(
            "That does not look like a valid email address.",
            externalSendBlocker(ExternalChannel.Email, "nope", "", ""),
        )
        assertEquals(
            "Add a recipient first.",
            externalSendBlocker(ExternalChannel.Sms, "  ", "", ""),
        )
    }

    // ---- decode ----

    @Test fun decodeSendResultHappy() {
        val r = decodeExternalSendResult("""{"ok":true,"channel":"email","providerMessageId":"sg_1","recipientRedacted":"n***@example.com"}""")
        assertEquals("email", r.channel)
        assertEquals("sg_1", r.providerMessageId)
        assertEquals("n***@example.com", r.recipientRedacted)
    }

    @Test fun decodeSendResultMissingFieldsBlankNotCrash() {
        val r = decodeExternalSendResult("""{"ok":true}""")
        assertEquals("", r.channel)
        assertEquals("", r.providerMessageId)
        assertEquals("", r.recipientRedacted)
    }

    @Test fun decodeSuppressResultHappy() {
        val r = decodeSuppressResult("""{"ok":true,"channel":"sms","recipientRedacted":"+1******7890"}""")
        assertEquals("sms", r.channel)
        assertEquals("+1******7890", r.recipientRedacted)
    }

    // ---- error mapping ----

    @Test fun optedOutErrorDetectedAndRephrased() {
        assertTrue(isOptedOutError("recipient_opted_out"))
        assertTrue(isOptedOutError("FAILED_PRECONDITION: recipient_opted_out"))
        assertFalse(isOptedOutError("SendGrid send failed: 401"))
        assertTrue(externalSendErrorText("recipient_opted_out").contains("opted out"))
    }

    @Test fun nonOptOutErrorPassesThroughVerbatim() {
        assertEquals("SendGrid send failed: 401", externalSendErrorText("SendGrid send failed: 401"))
    }
}
