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
    /** True when a kinfolk cancellation ask is pending on this visit. The
     *  status does NOT change; only the business cancels for real. */
    val cancelRequested: Boolean = false,
)

/** Result of the requestBookingCancellation callable. alreadyPending=true
 *  means an earlier ask is on file; the UI treats both as the pending state. */
data class CancelRequestResult(
    val ok: Boolean,
    val visitId: String,
    val alreadyPending: Boolean,
)

/** True while the visit is still ahead of us (requested or confirmed). */
fun Booking.isAwaitingVisit(): Boolean =
    status == BookingStatus.Requested || status == BookingStatus.Confirmed

/** True when the kinfolk can still ask to cancel: upcoming and no ask pending. */
fun Booking.canRequestCancellation(): Boolean = isAwaitingVisit() && !cancelRequested

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
