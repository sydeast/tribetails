package com.tribetails.auntieos.web.screens.auth
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
/** #1600: an empty submit names the empty field, and only that field. */
class SignInFieldErrorsTest {
    @Test
    fun `both empty names both fields`() {
        val e = signInFieldErrors("", "")
        assertEquals("Enter your email.", e.email)
        assertEquals("Enter your password.", e.password)
        assertTrue(e.any)
    }
    @Test
    fun `a blank email counts as empty`() {
        assertEquals("Enter your email.", signInFieldErrors("   ", "pw").email)
    }
    @Test
    fun `only the empty field is named`() {
        val onlyPassword = signInFieldErrors("auntie@tribetails.com", "")
        assertNull(onlyPassword.email)
        assertEquals("Enter your password.", onlyPassword.password)
        val onlyEmail = signInFieldErrors("", "pw")
        assertEquals("Enter your email.", onlyEmail.email)
        assertNull(onlyEmail.password)
    }
    @Test
    fun `filled fields raise nothing`() {
        val e = signInFieldErrors("auntie@tribetails.com", "pw")
        assertFalse(e.any)
    }
    @Test
    fun `reset without an email points at the email field`() {
        assertEquals("Type your email above first.", resetEmailFieldError(""))
        assertNull(resetEmailFieldError("auntie@tribetails.com"))
    }
}
