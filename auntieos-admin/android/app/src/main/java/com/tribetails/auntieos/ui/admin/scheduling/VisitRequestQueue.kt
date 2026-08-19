package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.contracts.CancelRequestDto
import com.tribetails.auntieos.data.contracts.RescheduleRequestDto

/**
 * The two asks a household can have waiting on a visit, in ONE queue: a
 * proposed new time (#399 item 2) and a cancellation (#438).
 *
 * One queue rather than two panels because it is one job for an operator --
 * somebody asked for something and is waiting on an answer -- and because the
 * React admin renders exactly this merged list above its Bookings table. Two
 * competing panels on the schedule screen would make the older, worse gap (the
 * cancellation ask, unread since 2026-07-02) look like a second-class feature
 * bolted on beside the newer one.
 *
 * Pure and unit-tested; the screen and the view model are shells around it.
 */
sealed interface VisitRequestRow {
    val kinfolkId: String
    val batchId: String
    val visitId: String

    /** What the row is about, for the title line. */
    val title: String

    /** The kin this visit is for, already joined for display. Blank when unknown. */
    val kinNames: String

    /** Why the household asked, or null when they gave no reason. */
    val reason: String?

    /** When they asked, epoch millis, or null when the record carries no stamp. */
    val requestedAtMs: Long?

    data class Reschedule(val dto: RescheduleRequestDto) : VisitRequestRow {
        override val kinfolkId: String get() = dto.kinfolkId
        override val batchId: String get() = dto.batchId
        override val visitId: String get() = dto.visitId
        override val title: String get() = dto.title ?: dto.serviceType ?: "Visit"
        override val kinNames: String get() = dto.kinNames.joinToString(", ")
        override val reason: String? get() = dto.reason
        override val requestedAtMs: Long? get() = dto.requestedAtMs
    }

    data class Cancel(val dto: CancelRequestDto) : VisitRequestRow {
        override val kinfolkId: String get() = dto.kinfolkId
        override val batchId: String get() = dto.batchId
        override val visitId: String get() = dto.visitId
        override val title: String get() = dto.title ?: dto.serviceType ?: "Visit"
        override val kinNames: String get() = dto.kinNames.joinToString(", ")
        override val reason: String? get() = dto.reason
        override val requestedAtMs: Long? get() = dto.requestedAtMs
    }
}

/**
 * The row's stable identity.
 *
 * Keyed on the KIND as well as the path, because a visit id is only unique
 * inside its household AND one visit can carry both asks at once: a household
 * that proposed a new time and then decided to cancel outright. Keying on the
 * path alone would collapse those two into one row and resolve the wrong one.
 */
val VisitRequestRow.key: String
    get() {
        val kind = if (this is VisitRequestRow.Cancel) "cancel" else "reschedule"
        return "$kind/$kinfolkId/$batchId/$visitId"
    }

/**
 * Merges the two queues, oldest first: the household that has been waiting
 * longest is the one to answer.
 *
 * A row with no `requestedAtMs` sorts LAST rather than to 1970. An unknown wait
 * is not a long one, and floating it to the top would push down a household
 * that really has been waiting since July.
 */
fun mergeVisitRequests(
    reschedule: List<RescheduleRequestDto>,
    cancel: List<CancelRequestDto>,
): List<VisitRequestRow> =
    (reschedule.map { VisitRequestRow.Reschedule(it) } + cancel.map { VisitRequestRow.Cancel(it) })
        .sortedBy { it.requestedAtMs ?: Long.MAX_VALUE }

/** The chip on the row: which ask this is, read before anything else on it. */
fun VisitRequestRow.kindLabel(): String = when (this) {
    is VisitRequestRow.Cancel -> "Cancel"
    is VisitRequestRow.Reschedule -> "Reschedule"
}

/** What the operator is about to do, in the future tense, before they do it. */
fun VisitRequestRow.acceptLabel(): String = when (this) {
    is VisitRequestRow.Cancel -> "Cancel the visit"
    is VisitRequestRow.Reschedule -> "Move the visit"
}

/** The label on the note field for a decline; a decline always needs a reason. */
fun VisitRequestRow.declineNoteLabel(): String = when (this) {
    is VisitRequestRow.Cancel -> "Why it is staying"
    is VisitRequestRow.Reschedule -> "Why the time does not work"
}
