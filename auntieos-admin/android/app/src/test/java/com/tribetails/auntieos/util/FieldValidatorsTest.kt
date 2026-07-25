package com.tribetails.auntieos.util

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FieldValidatorsTest {

    @Test
    fun phone_accepts_us_10_and_11_with_leading_1() {
        assertTrue(isValidPhone("5551234567"))
        assertTrue(isValidPhone("(555) 123-4567"))
        assertTrue(isValidPhone("+1 (555) 123-4567"))
        assertTrue(isValidPhone("555.123.4567"))
        assertTrue(isValidPhone("15551234567"))
    }

    @Test
    fun phone_rejects_wrong_length_and_letters() {
        assertFalse(isValidPhone("719390420"))      // 9 digits (the Alexis case)
        assertFalse(isValidPhone("555123456"))       // 9 digits
        assertFalse(isValidPhone("123456"))          // 6 digits
        assertFalse(isValidPhone("25551234567"))     // 11 digits, no leading 1
        assertFalse(isValidPhone("555abc1234"))      // letters
        assertFalse(isValidPhone(""))                // blank
    }

    @Test
    fun optional_blank_passes_but_junk_fails() {
        assertTrue(phoneOkOrBlank(""))               // optional, empty ok
        assertFalse(phoneOkOrBlank("719390420"))     // present but invalid
        assertTrue(emailOkOrBlank(""))               // optional, empty ok
        assertFalse(emailOkOrBlank("ydwuhh@"))        // present but invalid
        assertTrue(emailOkOrBlank("nora@example.com"))
    }

    // ── isValidE164Phone: the Communicate external-send rule ────────────────
    // Deliberately NOT the US rule above. External send reaches anybody at all,
    // and the US rule blocked every valid international number before the
    // server saw it, so the message could not be sent and no error said why.
    @Test
    fun e164_accepts_a_US_number_in_every_shape_an_operator_types() {
        assertTrue(isValidE164Phone("+15125550123"))
        assertTrue(isValidE164Phone("+1 (512) 555-0123"))
        assertTrue(isValidE164Phone("5125550123"))
    }
    @Test
    fun e164_accepts_international_numbers_the_US_rule_wrongly_rejected() {
        assertTrue(isValidE164Phone("+447700900123"))   // UK, 12 digits
        assertTrue(isValidE164Phone("+61412345678"))    // AU, 11 digits, no leading 1
        assertFalse(isValidPhone("+447700900123"))      // the old rule's blind spot
    }
    @Test
    fun e164_rejects_numbers_outside_the_8_to_15_digit_range() {
        assertFalse(isValidE164Phone("5551234"))            // 7 digits
        assertFalse(isValidE164Phone("+1234567890123456"))  // 16 digits
    }
    @Test
    fun e164_rejects_letters_and_blank() {
        assertFalse(isValidE164Phone("+1 512 CALL NOW"))
        assertFalse(isValidE164Phone("   "))
    }
}
