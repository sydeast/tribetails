package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1410: the same cases `functions/test/privacyPolicyUrl.test.ts` pins on the
 * server and the rules suite pins on `bsHttpsUrl`. A value that passes here must
 * pass there, or the operator sees Save light up and the write refused.
 */
class PrivacyPolicyUrlTest {

    @Test
    fun `blank and a plain https URL are valid`() {
        assertTrue(isValidPrivacyPolicyUrl(""))
        assertTrue(isValidPrivacyPolicyUrl("https://example.com"))
        assertTrue(isValidPrivacyPolicyUrl("https://example.com/privacy"))
        assertTrue(isValidPrivacyPolicyUrl("https://www.example.com/legal/privacy?lang=en#top"))
    }

    @Test
    fun `http, other schemes, a bare domain and a scheme with no host are refused`() {
        assertFalse(isValidPrivacyPolicyUrl("http://example.com/privacy"))
        assertFalse(isValidPrivacyPolicyUrl("javascript:alert(1)"))
        assertFalse(isValidPrivacyPolicyUrl("example.com/privacy"))
        assertFalse(isValidPrivacyPolicyUrl("https://"))
        assertFalse(isValidPrivacyPolicyUrl("https:///privacy"))
    }

    @Test
    fun `whitespace and characters that could break out of an href are refused`() {
        assertFalse(isValidPrivacyPolicyUrl("https://example.com/privacy policy"))
        assertFalse(isValidPrivacyPolicyUrl("https://example.com/\"onmouseover=\"x"))
        assertFalse(isValidPrivacyPolicyUrl("https://example.com/<b>"))
        assertFalse(isValidPrivacyPolicyUrl("https://example.com\\privacy"))
    }

    @Test
    fun `the length cap is exactly the constant`() {
        val prefix = "https://example.com/"
        val atCap = prefix + "a".repeat(PRIVACY_POLICY_URL_MAX_LENGTH - prefix.length)
        assertEquals(PRIVACY_POLICY_URL_MAX_LENGTH, atCap.length)
        assertTrue(isValidPrivacyPolicyUrl(atCap))
        assertFalse(isValidPrivacyPolicyUrl(atCap + "a"))
    }

    @Test
    fun `the field message is null for blank or a valid link, and names the fault otherwise`() {
        assertNull(privacyPolicyUrlError(""))
        assertNull(privacyPolicyUrlError("   "))
        assertNull(privacyPolicyUrlError("  https://example.com/privacy  "))
        assertEquals("Enter a full https:// link.", privacyPolicyUrlError("http://example.com/privacy"))
        assertEquals("Enter a full https:// link.", privacyPolicyUrlError("example.com/privacy"))
        assertEquals(
            "Keep the link under 2048 characters.",
            privacyPolicyUrlError("https://example.com/" + "a".repeat(PRIVACY_POLICY_URL_MAX_LENGTH)),
        )
    }
}
