package com.tribetails.auntieos.ui.admin.scheduling

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for booking conflict + travel-buffer detection. Backs
 * BookingRepository.evaluateAvailability; pulled into pure helpers so the
 * decision logic is JVM-testable without Firestore in the loop.
 */
class BookingConflictHelpersTest {

    @Test
    fun `intervalsOverlap detects strict overlap`() {
        assertTrue(intervalsOverlap(0L, 100L, 50L, 150L))
        assertTrue(intervalsOverlap(50L, 150L, 0L, 100L))
    }

    @Test
    fun `intervalsOverlap detects containment`() {
        assertTrue(intervalsOverlap(0L, 100L, 25L, 75L))
        assertTrue(intervalsOverlap(25L, 75L, 0L, 100L))
    }

    @Test
    fun `intervalsOverlap is false when adjacent (touching endpoints)`() {
        // 0-100 then 100-200 - the second starts exactly when the first ends.
        // Adjacent visits are allowed; only strict overlap is a conflict.
        assertFalse(intervalsOverlap(0L, 100L, 100L, 200L))
        assertFalse(intervalsOverlap(100L, 200L, 0L, 100L))
    }

    @Test
    fun `intervalsOverlap is false when fully separated`() {
        assertFalse(intervalsOverlap(0L, 100L, 200L, 300L))
    }

    @Test
    fun `hasTravelBufferViolation true when next visit too soon after previous`() {
        // Previous ends at t=100, next starts at t=120, buffer=30 minutes (1_800_000 ms)
        // Gap of 20ms is far less than 30min - but our buffer is in minutes
        val bufferMinutes = 30
        val bufferMs = bufferMinutes * 60_000L
        val prevEnd = 1_000_000L
        val nextStart = prevEnd + bufferMs - 60_000L   // 1 min short of buffer
        assertTrue(hasTravelBufferViolation(prevEnd, nextStart, bufferMinutes))
    }

    @Test
    fun `hasTravelBufferViolation false when next visit respects buffer`() {
        val bufferMinutes = 30
        val bufferMs = bufferMinutes * 60_000L
        val prevEnd = 1_000_000L
        val nextStart = prevEnd + bufferMs + 60_000L   // 1 min past buffer
        assertFalse(hasTravelBufferViolation(prevEnd, nextStart, bufferMinutes))
    }

    @Test
    fun `hasTravelBufferViolation false when nextStart is before prevEnd (overlap, not buffer)`() {
        // Overlap is a separate concern (caught by intervalsOverlap); buffer logic
        // only applies when nextStart >= prevEnd. Negative gaps mean overlap, not
        // a buffer violation.
        assertFalse(hasTravelBufferViolation(1_000_000L, 999_000L, 30))
    }

    @Test
    fun `hasTravelBufferViolation false when buffer is 0`() {
        // 0-minute buffer = "anything goes as long as no overlap".
        assertFalse(hasTravelBufferViolation(1_000_000L, 1_000_000L, 0))
    }

    @Test
    fun `minutesBetween computes elapsed minutes between two timestamps`() {
        val start = 0L
        val end   = 30 * 60_000L
        assertEquals(30L, minutesBetween(start, end))
    }

    @Test
    fun `minutesBetween returns negative for backward intervals`() {
        assertEquals(-5L, minutesBetween(5 * 60_000L, 0L))
    }
}
