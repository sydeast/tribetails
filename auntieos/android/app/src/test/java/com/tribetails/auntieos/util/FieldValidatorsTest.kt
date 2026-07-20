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
}
