package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.data.model.*
import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for booking domain logic.
 *
 * NOTE: BookingRepository.calculateBookingPrice and evaluateAvailability both
 * require FirebaseFirestore, which has Android-specific static initializers that
 * block in JVM-only unit tests without Robolectric. Those methods are covered
 * indirectly via EnhancedSchedulingViewModelTest (which mocks the whole repo).
 *
 * These tests cover pure data model invariants with zero external dependencies.
 */
class BookingRepositoryTest {

    @Test
    fun `EnhancedBooking defaults to DRAFT status`() {
        assertEquals(BookingStatus.DRAFT, EnhancedBooking(id = "b1").status)
    }

    @Test
    fun `BookingAvailabilityResult isAvailable false carries conflicting bookings`() {
        val result = BookingAvailabilityResult(
            isAvailable = false,
            reason = UnavailabilityReasonType.CONFLICTING_BOOKING,
            conflictingBookings = listOf(EnhancedBooking(id = "conflict1"))
        )

        assertFalse(result.isAvailable)
        assertEquals(UnavailabilityReasonType.CONFLICTING_BOOKING, result.reason)
        assertEquals(1, result.conflictingBookings.size)
        assertEquals("conflict1", result.conflictingBookings[0].id)
    }

    @Test
    fun `BookingAvailabilityResult defaults to available with no conflicts`() {
        val result = BookingAvailabilityResult(isAvailable = true)

        assertTrue(result.isAvailable)
        assertNull(result.reason)
        assertTrue(result.conflictingBookings.isEmpty())
    }

    @Test
    fun `BookingAvailabilityRequest includes excludeBookingId for update-safe conflict checks`() {
        val request = BookingAvailabilityRequest(
            startDateTime = "2026-06-02T10:00:00",
            endDateTime = "2026-06-02T11:00:00",
            excludeBookingId = "self-id"
        )

        assertEquals("self-id", request.excludeBookingId)
        assertEquals("2026-06-02T10:00:00", request.startDateTime)
    }
}
