package com.kinfolk.portal.util
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
class PhoneFormatTest {
    @Test
    fun formatsTheShapesTheQaWalkFound() {
        assertEquals("(512) 555-0142", formatPhone("+15125550142"))
        assertEquals("(512) 566-7512", formatPhone("5125667512"))
        assertEquals("(512) 555-0142", formatPhone("512-555-0142"))
        assertEquals("(512) 555-0142", formatPhone("1 (512) 555-0142"))
        assertEquals("(512) 555-0142", formatPhone("(512) 555-0142"))
    }
    @Test
    fun leavesInternationalAndUnrecognisedNumbersAsTyped() {
        assertEquals("+442079460958", formatPhone("+442079460958"))
        assertEquals("12345", formatPhone("12345"))
    }
    @Test
    fun isEmptyForNothingAndStable() {
        assertEquals("", formatPhone(null))
        assertEquals("", formatPhone("   "))
        assertEquals("(512) 555-0142", formatPhone(formatPhone("+15125550142")))
    }
    @Test
    fun acceptsBlankAndEveryUsShape() {
        listOf("", "  ", "5125550142", "512-555-0142", "(512) 555-0142", "+15125550142", "1 512 555 0142", "+442079460958")
            .forEach { assertNull(phoneProblem(it), it) }
    }
    @Test
    fun namesTheProblemInPlainWords() {
        assertEquals("Enter a 10-digit phone number.", phoneProblem("abc123"))
        listOf("12345", "512555014", "51255501421", "512-555-CALL", "+123")
            .forEach { assertEquals(PhoneFormat.PROBLEM, phoneProblem(it), it) }
    }
}
