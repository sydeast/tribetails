package com.tribetails.auntieos.web.util

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FieldValidatorsTest {

    // ----- isValidEmail -----

    @Test
    fun email_accepts_simple_addresses() {
        assertTrue(isValidEmail("nora@example.com"))
        assertTrue(isValidEmail("wanda.thorne@example.com"))
        assertTrue(isValidEmail("first.last+tag@sub.domain.io"))
    }

    @Test
    fun email_rejects_blank_and_obvious_junk() {
        assertFalse(isValidEmail(""))
        assertFalse(isValidEmail("   "))
        assertFalse(isValidEmail("nope"))
        assertFalse(isValidEmail("nope@"))
        assertFalse(isValidEmail("@example.com"))
        assertFalse(isValidEmail("nope@example"))
        assertFalse(isValidEmail("trailing.dot@example.com."))
    }

    @Test
    fun email_rejects_whitespace_inside() {
        assertFalse(isValidEmail("a b@example.com"))
        assertFalse(isValidEmail("ab@example .com"))
    }

    @Test
    fun email_trims_surrounding_whitespace() {
        assertTrue(isValidEmail("  nora@example.com  "))
    }

    // ----- isValidPhone -----

    @Test
    fun phone_accepts_common_formats() {
        assertTrue(isValidPhone("5551234567"))
        assertTrue(isValidPhone("(555) 123-4567"))
        assertTrue(isValidPhone("+1 (555) 123-4567"))
        assertTrue(isValidPhone("555.123.4567"))
        assertTrue(isValidPhone("  555-1234567  "))
    }

    @Test
    fun phone_rejects_letters() {
        assertFalse(isValidPhone("five-five-five-1234567"))
        assertFalse(isValidPhone("555abc1234"))
        assertFalse(isValidPhone("call me"))
    }

    @Test
    fun phone_enforces_us_10_digit_rule() {
        assertFalse(isValidPhone("719390420"))         // 9 digits (the Alexis case)
        assertFalse(isValidPhone("123456"))            // 6 digits
        assertFalse(isValidPhone("555123456"))         // 9 digits
        assertFalse(isValidPhone("1".repeat(16)))      // 16 digits
        assertFalse(isValidPhone("25551234567"))       // 11 digits, no leading 1
        assertTrue(isValidPhone("15551234567"))        // 11 digits, leading 1 (US country code)
        assertTrue(isValidPhone("5551234567"))         // 10 digits
    }

    @Test
    fun phone_rejects_blank() {
        assertFalse(isValidPhone(""))
        assertFalse(isValidPhone("   "))
    }
}
