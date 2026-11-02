package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1409: the same cases the rules suite pins on `bsNonBlankString` and the
 * React admin pins in `lib/businessName.test.ts`. A value that passes here
 * must pass there, or the operator sees Save light up and the write refused.
 */
class BusinessNameTest {

    @Test
    fun `any name with at least one non-space character is valid`() {
        assertTrue(isValidBusinessName("Sunny Paws"))
        assertTrue(isValidBusinessName("S"))
        assertTrue(isValidBusinessName("  Sunny Paws  "))
    }

    @Test
    fun `blank and whitespace are refused`() {
        assertFalse(isValidBusinessName(""))
        assertFalse(isValidBusinessName(" "))
        assertFalse(isValidBusinessName("   "))
        assertFalse(isValidBusinessName("\t\n"))
    }

    @Test
    fun `the field message is null for a name and asks for one otherwise`() {
        assertNull(businessNameError("Sunny Paws"))
        assertNull(businessNameError("  Sunny Paws  "))
        assertEquals("Enter the business name.", BUSINESS_NAME_REQUIRED_MESSAGE)
        assertEquals("Enter the business name.", businessNameError(""))
        assertEquals("Enter the business name.", businessNameError("   "))
    }
}
