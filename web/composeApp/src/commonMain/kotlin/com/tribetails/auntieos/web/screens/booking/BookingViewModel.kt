package com.tribetails.auntieos.web.screens.booking

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.AuntieDataSource
import com.tribetails.auntieos.web.data.BookingSeriesAction
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.WriteResult

class BookingViewModel(
    private val dataSource: AuntieDataSource,
    private val actorId: String = "",
) {

    var errorMessage: String? by mutableStateOf(null)
        private set

    /** Surface a screen-level error (e.g. a bulk action failure) fail-loud. */
    fun setError(message: String?) { errorMessage = message }

    fun bookingsStream() = dataSource.sessionsStream()

    // 16.5: incoming MyTribe booking-envelope requests + the directory (for names).
    fun incomingKinCaresStream() = dataSource.incomingKinCaresStream()
    fun kinfolkStream() = dataSource.kinfolkStream()

    /** batchId currently being approved/cancelled (drives the in-flight lock). */
    var seriesActionBatchId: String? by mutableStateOf(null)
        private set

    /** Approve/cancel a whole incoming series. The backend creates the linked
     *  sessions on APPROVE, so the client just calls + the stream refreshes. */
    suspend fun approveSeries(kinfolkId: String, batchId: String) = runSeries(BookingSeriesAction.APPROVE, kinfolkId, batchId)
    suspend fun cancelSeries(kinfolkId: String, batchId: String) = runSeries(BookingSeriesAction.CANCEL, kinfolkId, batchId)

    private suspend fun runSeries(action: String, kinfolkId: String, batchId: String) {
        if (seriesActionBatchId != null) return
        seriesActionBatchId = batchId
        val verb = if (action == BookingSeriesAction.APPROVE) "Approve" else "Cancel"
        when (val r = dataSource.manageBookingSeries(action, kinfolkId, batchId)) {
            is WriteResult.Ok -> {
                val res = r.value
                // FAIL LOUD on a partial failure: the backend returns ok with
                // failedVisits > 0 and leaves the envelope 'requested'. Reporting
                // that as a clean success would hide the stuck visits.
                errorMessage = if (res.failedVisits > 0) {
                    "$verb series $batchId: ${res.affectedVisits} succeeded, ${res.failedVisits} failed and stay pending. Retry after resolving."
                } else {
                    null
                }
                audit(
                    if (action == BookingSeriesAction.APPROVE) "APPROVE_BOOKING_SERIES" else "CANCEL_BOOKING_SERIES",
                    buildString {
                        append("$action booking series $batchId (${res.affectedVisits} ok")
                        if (res.failedVisits > 0) append(", ${res.failedVisits} failed")
                        append(")")
                    },
                    batchId,
                )
            }
            is WriteResult.Err -> errorMessage = "Series $action failed: ${r.message}"
        }
        seriesActionBatchId = null
    }

    suspend fun approveBooking(bookingId: String) {
        when (val r = dataSource.approveBooking(bookingId)) {
            is WriteResult.Ok  -> {
                errorMessage = null
                audit("APPROVE_BOOKING", "Approved booking $bookingId", bookingId)
            }
            is WriteResult.Err -> errorMessage = "Approve failed: ${r.message}"
        }
    }

    suspend fun rejectBooking(bookingId: String) {
        when (val r = dataSource.rejectBooking(bookingId)) {
            is WriteResult.Ok  -> {
                errorMessage = null
                audit("REJECT_BOOKING", "Rejected booking $bookingId", bookingId)
            }
            is WriteResult.Err -> errorMessage = "Reject failed: ${r.message}"
        }
    }

    suspend fun createBooking(
        booking: KinCareSession,
        kinfolkFacingNote: String = "",
        adminInternalNote: String = "",
    ) {
        if (booking.serviceType.isBlank()) {
            errorMessage = "Create booking failed: serviceType is required"
            return
        }
        when (val r = dataSource.createBooking(booking)) {
            is WriteResult.Ok  -> {
                errorMessage = null
                audit(
                    actionType  = "CREATE_BOOKING",
                    description = "Created ${booking.status.ifBlank { "DRAFT" }} booking for ${booking.kinfolkName.ifBlank { booking.kinfolkId }} (${booking.serviceType})",
                    targetId    = r.value,
                )
                val warnings = mutableListOf<String>()
                if (kinfolkFacingNote.isNotBlank()) {
                    when (val nr = dataSource.addBookingNote(booking.kinfolkId, r.value, kinfolkFacingNote)) {
                        is WriteResult.Err -> warnings += "Kinfolk-facing note save deferred: ${nr.message}"
                        else -> Unit
                    }
                }
                if (adminInternalNote.isNotBlank()) {
                    when (val nr = dataSource.addInternalBookingNote(booking.kinfolkId, r.value, adminInternalNote)) {
                        is WriteResult.Err -> warnings += "Internal note save deferred: ${nr.message}"
                        else -> Unit
                    }
                }
                if (warnings.isNotEmpty()) errorMessage = warnings.joinToString("; ")
            }
            is WriteResult.Err -> errorMessage = "Create booking failed: ${r.message}"
        }
    }

    fun clearError() { errorMessage = null }

    private suspend fun audit(actionType: String, description: String, targetId: String) {
        runCatching {
            dataSource.logActivity(
                ActivityLogEntry(
                    actionType       = actionType,
                    description      = description,
                    status           = "SUCCESS",
                    actorId          = actorId,
                    targetId         = targetId,
                    targetCollection = "kin_care_sessions",
                )
            )
        }
    }
}
