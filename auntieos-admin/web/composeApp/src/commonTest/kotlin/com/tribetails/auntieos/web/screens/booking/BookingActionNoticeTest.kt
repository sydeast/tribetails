package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.KinCareSession
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 1025: a landed single approve/reject/cancel used to report nothing -- the
 * card just moved sections on the next stream update, the same gap admin
 * web (React)'s BookingActions and Android's approveBooking/cancelBooking
 * closed for the same single-row shape. [bookingActionNotice] is the pure
 * wording helper `runApprove`/`runReject`/`runCancel` in BookingScreen.kt
 * call once the write lands.
 */
class BookingActionNoticeTest {

    @Test
    fun namesTheKinfolk() {
        val booking = KinCareSession(_id = "b1", kinfolkId = "kf1", kinfolkName = "The Whitfields")
        assertEquals("Approved The Whitfields.", bookingActionNotice("Approved", booking))
        assertEquals("Rejected The Whitfields.", bookingActionNotice("Rejected", booking))
        assertEquals("Cancelled The Whitfields.", bookingActionNotice("Cancelled", booking))
    }

    @Test
    fun fallsBackToTheKinfolkIdWhenNameIsBlank() {
        val booking = KinCareSession(_id = "b1", kinfolkId = "kf1", kinfolkName = "")
        assertEquals("Approved kf1.", bookingActionNotice("Approved", booking))
    }
}
