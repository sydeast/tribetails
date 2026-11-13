package com.tribetails.auntieos.web.screens.booking

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.AuntieDataSource
import com.tribetails.auntieos.web.data.BookingSeriesAction
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.MultiDateBookingResult
import com.tribetails.auntieos.web.data.NewBookingVisitInput
import com.tribetails.auntieos.web.data.ScheduleOverride
import com.tribetails.auntieos.web.data.overridableScheduleRefusal
import com.tribetails.auntieos.web.data.mintBookingIdempotencyKey
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.observability.runCatchingCancellable

/** #1145: an approval the server refused over a busy block or another visit, which the operator may approve over. */
data class ApproveConflict(val bookingId: String, val visitId: String?, val override: ScheduleOverride)
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

    /**
     * 1030: [approveSeries]/[cancelSeries] used to report nothing on a clean
     * success -- only [errorMessage] (a failure or a partial failure) ever
     * changed, so the operator saw the envelope disappear from "Incoming
     * requests" with nothing naming what had happened. Confirms the way the
     * single-row actions ([BookingScreen]'s own `actionNotice`) already do.
     *
     * Desktop's [com.tribetails.auntieos.web.data.ManageSeriesResult] carries
     * only affectedVisits/failedVisits (no householdNotified/newlyConfirmed
     * the way Android's richer series result does), so this reuses the exact
     * single-booking sentences rather than inventing a household-aware one
     * the data here cannot honestly back.
     */
    var seriesActionMessage: String? by mutableStateOf(null)
        private set

    fun clearSeriesActionMessage() { seriesActionMessage = null }

    /** Approve/cancel a whole incoming series. The backend creates the linked
     *  sessions on APPROVE, so the client just calls + the stream refreshes. */
    suspend fun approveSeries(kinfolkId: String, batchId: String, kinfolkName: String = "", note: String = "") =
        runSeries(BookingSeriesAction.APPROVE, kinfolkId, batchId, kinfolkName, note)
    suspend fun cancelSeries(kinfolkId: String, batchId: String, kinfolkName: String = "", note: String = "") =
        runSeries(BookingSeriesAction.CANCEL, kinfolkId, batchId, kinfolkName, note)

    /** #2030: [note] is the operator's note for the household; blank sends none. */
    private suspend fun runSeries(action: String, kinfolkId: String, batchId: String, kinfolkName: String = "", note: String = "") {
        if (seriesActionBatchId != null) return
        seriesActionBatchId = batchId
        // Cleared on every call, not just on a landed success: a stale
        // confirmation from a prior series must not linger while this one is
        // still in flight or ends in an error.
        seriesActionMessage = null
        val verb = if (action == BookingSeriesAction.APPROVE) "Approve" else "Cancel"
        val who = kinfolkName.ifBlank { kinfolkId }
        when (val r = dataSource.manageBookingSeries(action, kinfolkId, batchId, note.trim().takeIf { it.isNotEmpty() })) {
            is WriteResult.Ok -> {
                val res = r.value
                // FAIL LOUD on a partial failure: the backend returns ok with
                // failedVisits > 0 and leaves the envelope 'requested'. Reporting
                // that as a clean success would hide the stuck visits.
                if (res.failedVisits > 0) {
                    errorMessage = "$verb series $batchId: ${res.affectedVisits} succeeded, ${res.failedVisits} failed and stay pending. Retry after resolving."
                } else {
                    errorMessage = null
                    // 1030: cancelSeries is fed only from the incoming-requests
                    // stream (requested visits), so a CANCEL here is always a
                    // DECLINE of a request, never a cancellation of an already-
                    // scheduled visit -- the same constraint Android's own
                    // EnhancedSchedulingViewModel.householdLine documents. That
                    // is the REJECT sentence, not the CANCEL one.
                    seriesActionMessage = if (action == BookingSeriesAction.APPROVE)
                        "$who's request is now Scheduled."
                    else
                        "$who's request is cancelled."
                }
                // No line from here (#2162): `manageBookingSeries` writes the
                // series line itself, with its counts, and the server refuses a
                // client copy of that kind.
            }
            is WriteResult.Err -> errorMessage = "Series $action failed: ${r.message}"
        }
        seriesActionBatchId = null
    }

    /**
     * #1145: set when a direct session's approval was refused over a Google busy block or another visit, so the
     * screen can offer "Approve anyway". Never set for a closed day (no override exists) or for a row booked from
     * a visit (that path reports failures as plain sentences with no code).
     */
    var approveConflict: ApproveConflict? by mutableStateOf(null)
        private set
    suspend fun approveBooking(bookingId: String, visitId: String? = null) {
        approveConflict = null
        when (val r = dataSource.approveBooking(bookingId, visitId)) {
            is WriteResult.Ok  -> {
                errorMessage = null
                audit("APPROVE_BOOKING", "Approved booking $bookingId", bookingId)
            }
            is WriteResult.Err -> {
                errorMessage = "Approve failed: ${r.message}"
                if (visitId.isNullOrBlank()) {
                    overridableScheduleRefusal(r.code)?.let { approveConflict = ApproveConflict(bookingId, visitId, it) }
                }
            }
        }
    }
    /** Sends the refused approval again with the override the operator has now seen the reason for. */
    suspend fun approveAnyway() {
        val conflict = approveConflict ?: return
        approveConflict = null
        when (val r = dataSource.approveBookingOverriding(conflict.bookingId, conflict.visitId, conflict.override)) {
            is WriteResult.Ok  -> {
                errorMessage = null
                audit("APPROVE_BOOKING", "Approved booking ${conflict.bookingId} over a schedule conflict", conflict.bookingId)
            }
            // No second offer: the same losing move is not put to the operator twice.
            is WriteResult.Err -> errorMessage = "Approve failed: ${r.message}"
        }
    }
    fun clearApproveConflict() { approveConflict = null }

    suspend fun rejectBooking(bookingId: String, visitId: String? = null) {
        approveConflict = null
        when (val r = dataSource.rejectBooking(bookingId, visitId)) {
            is WriteResult.Ok  -> {
                errorMessage = null
                audit("REJECT_BOOKING", "Rejected booking $bookingId", bookingId)
            }
            is WriteResult.Err -> errorMessage = "Reject failed: ${r.message}"
        }
    }
    suspend fun cancelBooking(bookingId: String, visitId: String? = null) {
        approveConflict = null
        when (val r = dataSource.cancelBooking(bookingId, visitId)) {
            is WriteResult.Ok  -> {
                errorMessage = null
                // #1145: its own event. Cancel used to log as REJECT_BOOKING, which made calling off a promised
                // visit read the same as turning down a request nobody had approved.
                audit("CANCEL_BOOKING", "Cancelled booking $bookingId", bookingId)
            }
            is WriteResult.Err -> errorMessage = "Cancel failed: ${r.message}"
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

    /**
     * AO-25: create a multi-date / recurring booking REQUEST (envelope model). On
     * success returns the result (batchId + visitCount); the request enters the
     * Incoming-requests queue for approval, so it appears in that live stream, not
     * the scheduled sessions list. Fail-loud into [errorMessage] on rejection.
     */
    suspend fun createBookingRequest(
        kinfolkId: String,
        visits: List<NewBookingVisitInput>,
        notes: String?,
        pattern: String,
        weeklyDays: List<Int>?,
        /** #1626: the form's "Admin internal notes", staff-only. */
        staffNotes: String? = null,
    ): MultiDateBookingResult? {
        errorMessage = null
        // #644: one key per submission, not per press. Held while the booking
        // being submitted is unchanged, so an operator who presses Create again
        // after a failure names the booking the first attempt may already have
        // made; re-minted the moment the booking itself changes, because a held
        // key would then replay the OLD booking and report it as the new one.
        val key = requestKeyFor(listOf(kinfolkId, pattern, notes, staffNotes, weeklyDays, visits).toString())
        return when (
            val r = dataSource.createMultiDateBookingRequest(
                kinfolkId, visits, notes, pattern, weeklyDays,
                idempotencyKey = key,
                staffNotes = staffNotes,
            )
        ) {
            is WriteResult.Ok -> {
                pendingRequestKey = null
                audit(
                    actionType = "CREATE_BOOKING",
                    description = "Created ${r.value.visitCount} visit(s) ($pattern) request for $kinfolkId",
                    targetId = r.value.batchId,
                )
                r.value
            }
            is WriteResult.Err -> {
                errorMessage = "Create booking request failed: ${r.message}"
                null
            }
        }
    }

    /**
     * #1674: New booking's "Submit request", for every repeat mode. One visit used
     * to be written straight to `kin_care_sessions` as PENDING with no booking
     * record, so once approved it could not be given an Auntie or notes ("This
     * visit is not part of a booking request" on every client), and its two notes
     * went to calls that name no record. Now one visit is a request with a record
     * like several are (AO-25's envelope path, `createMultiDateBookingRequest`):
     * it lands in Incoming requests, its notes ride the request (#1579, #1626),
     * and the server's busy and closed-day checks answer it in their own words.
     * [serviceType] is the KinCare type; the server prices it at invoice time.
     */
    suspend fun submitBookingRequest(
        kinfolkId: String,
        serviceType: String,
        visitStartsMs: List<Long>,
        repeat: BookingRepeat,
        weekdays: Set<Int>,
        kinfolkNote: String,
        staffNote: String,
    ): MultiDateBookingResult? {
        if (visitStartsMs.isEmpty()) {
            errorMessage = "Pick a date for the visit."
            return null
        }
        val weekly = repeat == BookingRepeat.WEEKLY
        return createBookingRequest(
            kinfolkId = kinfolkId,
            visits = visitStartsMs.map { NewBookingVisitInput(startTimeMs = it, serviceName = serviceType) },
            notes = kinfolkNote.ifBlank { null },
            pattern = if (weekly) "weekly" else "individual",
            weeklyDays = if (weekly) weekdays.sorted() else null,
            staffNotes = staffNote.ifBlank { null },
        )
    }

    /**
     * #1726: New booking's "Save draft". One DRAFT `kin_care_sessions` row per
     * visit the form names, so Several dates and Weekly keep every date (the
     * old path kept only the first). Approving a draft writes its booking record
     * (`transitionBookingStatus`, the #1630 shape Android's draft has), so the
     * approved visit can be given an Auntie and notes.
     *
     * The two notes ride on the row rather than going to `addBookingNote` /
     * `addInternalBookingNote`: a draft has no booking record for them to land
     * on, and on this console those calls are stubs ("note save deferred"). The
     * household's note is `kinfolkNotes`, which the approval copies onto the
     * record; the office's note is the session's own `notes`, where
     * `createKinCareSession` keeps it too.
     *
     * Returns how many drafts were saved. A failure names how many did not.
     */
    @OptIn(kotlin.time.ExperimentalTime::class)
    suspend fun saveDraft(
        kinfolkId: String,
        kinfolkName: String,
        serviceType: String,
        visitStartsMs: List<Long>,
        kinfolkNote: String,
        staffNote: String,
        formValues: Map<String, String> = emptyMap(),
    ): Int {
        errorMessage = null
        if (serviceType.isBlank()) {
            errorMessage = "Save draft failed: pick a KinCare type."
            return 0
        }
        if (visitStartsMs.isEmpty()) {
            errorMessage = "Pick a date for the visit."
            return 0
        }
        var saved = 0
        val failures = mutableListOf<String>()
        for (startMs in visitStartsMs) {
            val draft = KinCareSession(
                kinfolkId = kinfolkId,
                kinfolkName = kinfolkName,
                serviceType = serviceType,
                startTime = kotlin.time.Instant.fromEpochMilliseconds(startMs).toString(),
                notes = staffNote.trim(),
                kinfolkNotes = kinfolkNote.trim(),
                status = "DRAFT",
                formValues = formValues,
            )
            when (val r = dataSource.createBooking(draft)) {
                is WriteResult.Ok -> {
                    saved += 1
                    audit(
                        actionType = "CREATE_BOOKING",
                        description = "Created DRAFT booking for ${kinfolkName.ifBlank { kinfolkId }} ($serviceType)",
                        targetId = r.value,
                    )
                }
                is WriteResult.Err -> failures += r.message
            }
        }
        if (failures.isNotEmpty()) {
            errorMessage = "Save draft failed for ${failures.size} of ${visitStartsMs.size} visit(s): ${failures.first()}"
        }
        return saved
    }

    /** #644: the submission signature this key was minted for, and the key. */
    private var pendingRequestKey: Pair<String, String>? = null

    private fun requestKeyFor(signature: String): String {
        pendingRequestKey?.let { (held, key) -> if (held == signature) return key }
        val minted = mintBookingIdempotencyKey()
        pendingRequestKey = signature to minted
        return minted
    }

    fun clearError() { errorMessage = null; approveConflict = null }

    private suspend fun audit(actionType: String, description: String, targetId: String) {
        runCatchingCancellable {
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
