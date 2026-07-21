package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for SecuritySection email gate. We use plausibility (not full
 * RFC 5322) - Firebase Auth does the strict validation server-side. The UI
 * helper just blocks obvious garbage from triggering an API call.
 */
class SecurityHelpersTest {

    @Test
    fun `isPlausibleEmail accepts well-formed addresses`() {
        assertTrue(isPlausibleEmail("user@example.com"))
        assertTrue(isPlausibleEmail("a.b+tag@sub.example.co"))
        assertTrue(isPlausibleEmail("  spaced@example.com  "))
    }

    @Test
    fun `isPlausibleEmail rejects malformed strings`() {
        assertFalse(isPlausibleEmail(""))
        assertFalse(isPlausibleEmail("no-at-sign"))
        assertFalse(isPlausibleEmail("@no-local.com"))
        assertFalse(isPlausibleEmail("no-domain@"))
        assertFalse(isPlausibleEmail("a@b"))           // missing TLD
        assertFalse(isPlausibleEmail("a@b."))          // empty TLD
        assertFalse(isPlausibleEmail("two@@example.com"))
    }

    @Test
    fun `isPlausibleEmail rejects whitespace-only`() {
        assertFalse(isPlausibleEmail("   "))
        assertFalse(isPlausibleEmail("\t\n"))
    }

    // ---- credential-change error mapping (spec 29 item 15.4) ----

    @Test
    fun `wrong password maps to clear copy`() {
        assertTrue(friendlyAuthErrorForCode("ERROR_WRONG_PASSWORD", null).contains("Current password is incorrect"))
        assertTrue(friendlyAuthErrorForCode("ERROR_INVALID_CREDENTIAL", null).contains("incorrect"))
    }

    @Test
    fun `requires recent login asks to reauth`() {
        assertTrue(friendlyAuthErrorForCode("ERROR_REQUIRES_RECENT_LOGIN", null).contains("sign in again"))
    }

    @Test
    fun `email in use and weak password mapped`() {
        assertTrue(friendlyAuthErrorForCode("ERROR_EMAIL_ALREADY_IN_USE", null).contains("already in use"))
        assertTrue(friendlyAuthErrorForCode("ERROR_WEAK_PASSWORD", null).contains("stronger"))
    }

    @Test
    fun `unknown code surfaces raw message, never swallowed`() {
        assertTrue(friendlyAuthErrorForCode(null, "weird network thing").contains("weird network thing"))
        assertTrue(friendlyAuthErrorForCode(null, null).contains("Couldn't complete"))
    }
}
