package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.KinCareSession
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 1025/1030: a landed single approve/reject/cancel used to report nothing --
 * the card just moved sections on the next stream update, the same gap admin
 * web (React)'s BookingActions and Android's approveBooking/cancelBooking
 * closed for the same single-row shape. [bookingActionNotice] is the pure
 * wording helper `runApprove`/`runReject`/`runCancel` in BookingScreen.kt
 * call once the write lands.
 *
 * #1030: the wording itself used to be "Approved {name}." / "Rejected
 * {name}." / "Cancelled {name}.", drifted from admin web's own
 * `ActionDef.confirmedToast` sentences. Reworded to match exactly, the same
 * fix #1009 made for kinfolk saves.
 */
class BookingActionNoticeTest {

    @Test
    fun namesTheKinfolk() {
        val booking = KinCareSession(_id = "b1", kinfolkId = "kf1", kinfolkName = "The Whitfields")
        assertEquals("The Whitfields's request is now Scheduled.", bookingActionNotice(BookingActionOutcome.APPROVED, booking))
        assertEquals("The Whitfields's request is cancelled.", bookingActionNotice(BookingActionOutcome.REJECTED, booking))
        assertEquals("The Whitfields's visit is cancelled.", bookingActionNotice(BookingActionOutcome.CANCELLED, booking))
    }

    @Test
    fun fallsBackToTheKinfolkIdWhenNameIsBlank() {
        val booking = KinCareSession(_id = "b1", kinfolkId = "kf1", kinfolkName = "")
        assertEquals("kf1's request is now Scheduled.", bookingActionNotice(BookingActionOutcome.APPROVED, booking))
    }
}
