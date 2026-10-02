package com.tribetails.auntieos.web.screens.booking
import com.tribetails.auntieos.web.data.BatchBookingFailure
import com.tribetails.auntieos.web.data.BatchBookingResult
import com.tribetails.auntieos.web.data.KinCareSession
import kotlin.test.Test
import kotlin.test.assertEquals
/**
 * #1122: the Bookings bulk bar must send the id `batchUpdateBookings` resolves
 * (a kinCares visit id), the same one admin web's `bookingBulk.ts` and Android
 * send, never a `kin_care_sessions` row id when the row carries a visit id.
 */
class BulkVisitIdTest {
    @Test
    fun prefersTheKinCareVisitIdOverEverythingElse() {
        val b = KinCareSession(_id = "vis_v1", sourceBookingId = "legacy-9", kinCareVisitId = "v1")
        assertEquals("v1", bulkVisitId(b))
    }
    @Test
    fun usesTheVisitIdWhenSourceBookingIdIsBlank() {
        val b = KinCareSession(_id = "vis_v2", sourceBookingId = "", kinCareVisitId = "v2")
        assertEquals("v2", bulkVisitId(b))
    }
    @Test
    fun fallsBackToSourceBookingIdWhenThereIsNoVisitId() {
        val b = KinCareSession(_id = "s3", sourceBookingId = "src3", kinCareVisitId = " ")
        assertEquals("src3", bulkVisitId(b))
    }
    @Test
    fun aDirectSessionKeepsItsOwnRowId() {
        assertEquals("s4", bulkVisitId(KinCareSession(_id = "s4")))
    }
    @Test
    fun failuresNameTheBookingInPlainWords() {
        val result = BatchBookingResult(
            action = "APPROVE",
            updated = 0,
            failed = listOf(
                BatchBookingFailure("v1", "not-found"),
                BatchBookingFailure("zz", "write-failed"),
                BatchBookingFailure("v3", "That time is already booked."),
            ),
        )
        assertEquals(
            "The Whitfields: That booking was not found. A booking: The change could not be saved. Pip: That time is already booked.",
            bulkFailureText(result, mapOf("v1" to "The Whitfields", "v3" to "Pip")),
        )
    }
}
