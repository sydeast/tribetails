package com.tribetails.auntieos.web.screens.booking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
/**
 * #1578: a visit the field app moved to ON_MY_WAY, ARRIVED or DEPARTED is still
 * on the books. The desktop Bookings screen used to file it under History with
 * no Cancel, the same gap the web list had.
 */
class BookingInFlightTest {
    @Test
    fun aVisitUnderWayIsStillOnTheBooks() {
        for (status in listOf("SCHEDULED", "ON_MY_WAY", "arrived", " Departed ")) {
            assertTrue(isOnTheBooks(status), status)
        }
    }
    @Test
    fun requestsAndFinishedVisitsAreNot() {
        for (status in listOf("DRAFT", "PENDING", "COMPLETED", "CANCELLED", "", "WAT")) {
            assertFalse(isOnTheBooks(status), status)
        }
    }
    @Test
    fun thePillReadsOnTheWayAsAuntieTimeDoes() {
        assertEquals("ON THE WAY", bookingStatusLabel("ON_MY_WAY"))
        assertEquals("DEPARTED", bookingStatusLabel("departed"))
        assertEquals("SCHEDULED", bookingStatusLabel("SCHEDULED"))
    }
}
