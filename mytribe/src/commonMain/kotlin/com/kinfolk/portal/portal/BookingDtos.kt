package com.kinfolk.portal.portal

enum class BookingStatus { Requested, Confirmed, EnRoute, Active, Completed, Cancelled }
enum class VisitProgress { Confirmed, EnRoute, Active, Ended }

/** Envelope-level rollup status across a batch of KinCares. */
enum class EnvelopeStatus { Requested, PartiallyConfirmed, Confirmed, InProgress, Completed, Cancelled }

/**
 * One KinCare (a single visit/session). `batchId` ties it to its parent
 * [BookingEnvelope]; `sourceBookingId` and `sessionId` link back to the
 * originating booking doc and the live kin_care_session when present. All three
 * default null so pre-envelope constructors and tests keep compiling.
 */
data class Booking(
    val id: String,
    val kinfolkId: String,
    val status: BookingStatus,
    val serviceType: String?,
    val title: String?,
    val startTimeMs: Long?,
    val endTimeMs: Long?,
    val kinIds: List<String>,
    val kinNames: List<String>,
    val auntieDisplayName: String?,
    val auntieAvatarUrl: String?,
    val notes: String?,
    val createdAtMs: Long?,
    val visitProgress: VisitProgress?,
    val batchId: String? = null,
    val sourceBookingId: String? = null,
    val sessionId: String? = null,
    /** True when a kinfolk cancellation ask is PENDING on this visit. The
     *  status does NOT change; only the business cancels for real. Pending, not
     *  "was ever asked": a declined ask clears this so the household can ask
     *  again, with [cancelRequestStatus] carrying what happened. */
    val cancelRequested: Boolean = false,
    /**
     * Where the kinfolk's cancellation ask stands (#438), or null when this
     * visit has never had one. The reason and the office's note survive the
     * decision on purpose, so the screen can say what came back rather than
     * silently reopening the button.
     */
    val cancelRequestStatus: CancelRequestStatus? = null,
    val cancelRequestReason: String? = null,
    /** What the office said when it accepted or declined the cancellation. */
    val cancelResponseNote: String? = null,
    /**
     * Where the kinfolk's ask for a new time stands, or null when this visit
     * has never had one. The proposed window and the office's note survive the
     * decision on purpose, so the screen can say what was asked for and what
     * came back rather than only "declined".
     */
    val rescheduleRequestStatus: RescheduleRequestStatus? = null,
    val rescheduleRequestedStartTimeMs: Long? = null,
    val rescheduleRequestedEndTimeMs: Long? = null,
    val rescheduleRequestReason: String? = null,
    /** What the office said when it accepted or declined. */
    val rescheduleResponseNote: String? = null,
    /**
     * #1098: a night-only visit (the overnight) waiting for the Auntie to set
     * its start time. [startTimeMs] is null until she does, and [requestedDate]
     * carries the night. An older server sends neither field: false and null.
     */
    val startTimePending: Boolean = false,
    /** #1098: the night asked for, `YYYY-MM-DD`, or null. */
    val requestedDate: String? = null,
)

/**
 * The three answers a reschedule ask can be waiting on. Anything else the
 * server sends decodes to null, which reads as "never asked" — the same
 * tolerance the server's own `rescheduleStatusOf` applies on the way out.
 */
enum class RescheduleRequestStatus { Pending, Accepted, Declined }

/**
 * The three answers a cancellation ask can be waiting on (#438). Anything else
 * the server sends decodes to null, which reads as "never asked": the same
 * tolerance the reschedule status above applies, and the tolerance an older
 * deployed getMyBookings needs, since it sends no such field at all.
 */
enum class CancelRequestStatus { Pending, Accepted, Declined }

/** Result of the requestBookingCancellation callable. alreadyPending=true
 *  means an earlier ask is on file; the UI treats both as the pending state. */
data class CancelRequestResult(
    val ok: Boolean,
    val visitId: String,
    val alreadyPending: Boolean,
    /**
     * #1281: the visit as the server stored it after this ask, in the shape
     * getMyBookings lists it. The screen shows it at once instead of waiting on
     * a second read. Null from an older server or a failed read-back.
     */
    val visit: Booking? = null,
)

/**
 * Result of the requestBookingReschedule callable: what the server recorded,
 * echoed back so no client has to trust its own arithmetic.
 * [proposedEndTimeMs] is null when the visit had no end time to carry the
 * duration over from.
 */
data class RescheduleRequestResult(
    val ok: Boolean,
    val visitId: String,
    val proposedStartTimeMs: Long,
    val proposedEndTimeMs: Long?,
    /**
     * #1281: the visit as the server stored it after this ask, in the shape
     * getMyBookings lists it. The screen shows it at once instead of waiting on
     * a second read. Null from an older server or a failed read-back.
     */
    val visit: Booking? = null,
)

/** True while the visit is still ahead of us (requested or confirmed). */
fun Booking.isAwaitingVisit(): Boolean =
    status == BookingStatus.Requested || status == BookingStatus.Confirmed

/**
 * #1298: the one wording of a booking's status, for the list pill, the Home
 * pill and the detail badge alike. The web portal's `bookingStatusChip` says
 * the same six words, so one booking reads the same on every screen of both
 * clients. Callers pick their own colour; none picks its own words.
 */
fun BookingStatus.label(): String = when (this) {
    BookingStatus.Requested -> "REQUESTED"
    BookingStatus.Confirmed -> "CONFIRMED"
    BookingStatus.EnRoute -> "EN ROUTE"
    BookingStatus.Active -> "IN PROGRESS"
    BookingStatus.Completed -> "COMPLETED"
    BookingStatus.Cancelled -> "CANCELLED"
}
/**
 * #1299: a change the household asked for that the office has not ruled on.
 * The server now refuses a second ask while one is open, so a visit carries
 * one at most; a visit written before that rule can carry both, and the
 * cancellation is the one named because it ends the visit.
 */
fun Booking.pendingChangeLabel(): String? = when {
    cancelRequested || cancelRequestStatus == CancelRequestStatus.Pending -> "Cancellation requested"
    rescheduleRequestStatus == RescheduleRequestStatus.Pending -> "New time requested"
    else -> null
}
/**
 * True when the kinfolk can still ask to cancel: upcoming, no cancellation ask
 * pending, and (#1299) no new time waiting. The server refuses the ask in that
 * last case, so the control is not offered to fail.
 */
fun Booking.canRequestCancellation(): Boolean =
    isAwaitingVisit() && !cancelRequested && rescheduleRequestStatus != RescheduleRequestStatus.Pending

/**
 * True when the kinfolk can propose a new time for this visit.
 *
 * Same window as a cancellation ask, and for the same reason: a visit that is
 * under way or finished is not moved by asking. A pending ask blocks a second
 * one, which is the server's rule too — it refuses rather than quietly
 * replacing the time the office may already be looking at. [batchId] has to be
 * real: a visit AuntieOS scheduled with no booking envelope has nothing for the
 * callable to address, so the control stays off the screen rather than failing
 * on tap.
 */
fun Booking.canRequestReschedule(): Boolean =
    isAwaitingVisit() &&
        batchId != null &&
        !startTimePending &&
        rescheduleRequestStatus != RescheduleRequestStatus.Pending &&
        // #1299: the server refuses a new time while a cancellation is waiting.
        !cancelRequested &&
        cancelRequestStatus != CancelRequestStatus.Pending
/**
 * #1098: an upcoming night still waiting for the Auntie to set its start. It
 * cannot be rescheduled yet (`requestBookingReschedule` refuses it), so the
 * household is told why instead of offered a control that can only fail.
 * Cancelling it stays open.
 */
fun Booking.awaitingStartTime(): Boolean = isAwaitingVisit() && startTimePending

/**
 * The Booking envelope: a parent grouping over 1+ KinCares that share a
 * `batchId`. Surfaced only when the bookingEnvelope flag is ON.
 */
data class BookingEnvelope(
    val batchId: String,
    val envelopeStatus: EnvelopeStatus,
    val pattern: String?,
    val serviceName: String?,
    val kinIds: List<String>,
    val kinNames: List<String>,
    val notes: String?,
    val visitCount: Int,
    val confirmedCount: Int,
    val completedCount: Int,
    val firstStartTimeMs: Long?,
    val lastStartTimeMs: Long?,
    val kinCares: List<Booking>,
)

data class BookingsResult(
    val liveVisit: Booking?,
    val upcoming: List<Booking>,
    val recent: List<Booking>,
    val envelopes: List<BookingEnvelope> = emptyList(),
)
