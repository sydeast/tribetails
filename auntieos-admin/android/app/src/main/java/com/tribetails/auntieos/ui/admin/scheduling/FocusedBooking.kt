package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.KinCareSession

/**
 * #2367: WHERE A NOTICE'S OPEN LANDS ON BOOKINGS, for a whole booking.
 *
 * A notice about a whole booking (`kincare.requested`, `kincare.booking.confirm`,
 * `kincare.request.declined`, `assignment.assigned`) names the household and the
 * booking's batch id. Bookings is focused on that pair and decides, in three
 * stages, what to show:
 *  1. the request queue is still loading (or its read failed): wait, as before;
 *  2. the queue holds the request: its card opens, as before (#2028);
 *  3. the queue has loaded without it: the household's visits are read and the
 *     ones that belong to this booking are shown highlighted, or Bookings says
 *     the booking is no longer available.
 *
 * Every decision here is pure; the view model only runs the read.
 */

/** The household visits read for stage 3. Null on the state means not started. */
sealed interface FocusedBookingLookup {
    data object Loading : FocusedBookingLookup
    data class Found(val sessions: List<KinCareSession>) : FocusedBookingLookup
    data class Failed(val message: String) : FocusedBookingLookup
}

/** What Bookings shows for the focused booking. */
sealed interface FocusedBookingStage {
    /** Nothing focused. */
    data object None : FocusedBookingStage

    /** The request queue is not known yet (or its read failed): nothing extra is shown. */
    data object Waiting : FocusedBookingStage

    /** The queue holds the request: its card opens its sheet. */
    data object OpenCard : FocusedBookingStage

    /** The household's visits are being read. */
    data object LookingUp : FocusedBookingStage

    /** The booking's visits, oldest first. Never empty. */
    data class Booked(val sessions: List<KinCareSession>) : FocusedBookingStage

    /** No visit of this household carries this booking. */
    data object Gone : FocusedBookingStage

    /** The visits read failed, with the error's own words ("" when it had none). */
    data class LookupFailed(val message: String) : FocusedBookingStage
}

/**
 * The visits of one booking among a household's visits: the batch id AND the
 * household must both match, so another household's visit that happens to
 * carry the same batch id is never shown. Oldest first. Pure; unit-tested.
 */
fun sessionsOfBooking(sessions: List<KinCareSession>, kinfolkId: String, batchId: String): List<KinCareSession> {
    val kin = kinfolkId.trim()
    val batch = batchId.trim()
    if (kin.isEmpty() || batch.isEmpty()) return emptyList()
    return sessions
        .filter { it.kinCareBatchId?.trim() == batch && it.kinfolkId.trim() == kin }
        .sortedBy { it.startTime }
}

/**
 * The stage for the focused [kinfolkId] and [batchId], given whether the
 * request queue is live, the requests it holds ([queueKeys], as
 * [incomingRequestKey]s) and the visits read so far. Pure; unit-tested.
 */
fun focusedBookingStage(
    kinfolkId: String?,
    batchId: String?,
    incomingLive: Boolean,
    queueKeys: Set<String>,
    lookup: FocusedBookingLookup?,
): FocusedBookingStage {
    if (kinfolkId.isNullOrBlank() || batchId.isNullOrBlank()) return FocusedBookingStage.None
    if (!incomingLive) return FocusedBookingStage.Waiting
    if (incomingRequestKey(kinfolkId, batchId) in queueKeys) return FocusedBookingStage.OpenCard
    return when (lookup) {
        null, FocusedBookingLookup.Loading -> FocusedBookingStage.LookingUp
        is FocusedBookingLookup.Found ->
            if (lookup.sessions.isEmpty()) FocusedBookingStage.Gone else FocusedBookingStage.Booked(lookup.sessions)
        is FocusedBookingLookup.Failed -> FocusedBookingStage.LookupFailed(lookup.message)
    }
}

/** The visits read has to start: stage 3 is reached and nothing has been read yet. */
fun focusedBookingNeedsLookup(stage: FocusedBookingStage, lookup: FocusedBookingLookup?): Boolean =
    stage == FocusedBookingStage.LookingUp && lookup == null

const val FOCUSED_BOOKING_LOOKING_UP = "Looking this booking up…"
const val FOCUSED_BOOKING_TITLE = "This booking"
const val FOCUSED_BOOKING_GONE_TITLE = "This booking is no longer available"
const val FOCUSED_BOOKING_GONE_BODY = "It was turned down, withdrawn or removed, so there is nothing to open."
const val FOCUSED_BOOKING_FAILED_TITLE = "Couldn't look this booking up"

/** The banner line for a booked booking with [count] visits. */
fun focusedBookingBody(count: Int): String =
    if (count == 1) "Its visit is highlighted below." else "Its $count visits are highlighted below."
