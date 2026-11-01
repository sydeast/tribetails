package com.kinfolk.portal.portal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
/**
 * #1298 / #1299: one wording for a booking's status on every screen, and one
 * answer to "is a change waiting", with the ask buttons held while one is.
 * The web portal's `portalFormat.test.ts` pins the same words.
 */
class BookingStatusLabelsTest {
    private fun booking(
        status: BookingStatus = BookingStatus.Confirmed,
        cancel: CancelRequestStatus? = null,
        reschedule: RescheduleRequestStatus? = null,
    ) = Booking(
        id = "v1",
        kinfolkId = "fam-1",
        status = status,
        serviceType = "Drop-in",
        title = null,
        startTimeMs = 1_000L,
        endTimeMs = null,
        kinIds = emptyList(),
        kinNames = emptyList(),
        auntieDisplayName = null,
        auntieAvatarUrl = null,
        notes = null,
        createdAtMs = null,
        visitProgress = null,
        batchId = "b1",
        cancelRequested = cancel == CancelRequestStatus.Pending,
        cancelRequestStatus = cancel,
        rescheduleRequestStatus = reschedule,
    )
    @Test
    fun `every status has one word, the same as the web portal`() {
        assertEquals(
            listOf("REQUESTED", "CONFIRMED", "EN ROUTE", "IN PROGRESS", "COMPLETED", "CANCELLED"),
            BookingStatus.entries.map { it.label() },
        )
    }
    @Test
    fun `no change label when nothing is open or the office has answered`() {
        assertNull(booking().pendingChangeLabel())
        assertNull(
            booking(cancel = CancelRequestStatus.Declined, reschedule = RescheduleRequestStatus.Accepted)
                .pendingChangeLabel(),
        )
    }
    @Test
    fun `names the open ask`() {
        assertEquals("New time requested", booking(reschedule = RescheduleRequestStatus.Pending).pendingChangeLabel())
        assertEquals("Cancellation requested", booking(cancel = CancelRequestStatus.Pending).pendingChangeLabel())
    }
    @Test
    fun `a visit carrying both names the cancellation`() {
        assertEquals(
            "Cancellation requested",
            booking(cancel = CancelRequestStatus.Pending, reschedule = RescheduleRequestStatus.Pending)
                .pendingChangeLabel(),
        )
    }
    @Test
    fun `a waiting new time holds the cancellation ask`() {
        val b = booking(reschedule = RescheduleRequestStatus.Pending)
        assertFalse(b.canRequestCancellation())
        assertFalse(b.canRequestReschedule())
    }
    @Test
    fun `a waiting cancellation holds the new-time ask`() {
        val b = booking(cancel = CancelRequestStatus.Pending)
        assertFalse(b.canRequestReschedule())
        assertFalse(b.canRequestCancellation())
    }
    @Test
    fun `a declined ask frees both`() {
        val b = booking(cancel = CancelRequestStatus.Declined, reschedule = RescheduleRequestStatus.Declined)
        assertTrue(b.canRequestCancellation())
        assertTrue(b.canRequestReschedule())
    }
}
