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
)

/** True while the visit is still ahead of us (requested or confirmed). */
fun Booking.isAwaitingVisit(): Boolean =
    status == BookingStatus.Requested || status == BookingStatus.Confirmed

/** True when the kinfolk can still ask to cancel: upcoming and no ask pending. */
fun Booking.canRequestCancellation(): Boolean = isAwaitingVisit() && !cancelRequested

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
        rescheduleRequestStatus != RescheduleRequestStatus.Pending

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
