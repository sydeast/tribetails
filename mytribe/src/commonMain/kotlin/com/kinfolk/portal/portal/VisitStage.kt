package com.kinfolk.portal.portal

/**
 * #1830 / #1832 / #1823: a visit's place in its life as the household reads it.
 *
 * One more value than [BookingStatus], because Departed has no status of its
 * own on the wire: the server sends it as `status: active` with
 * `visitProgress: ended` (`functions/src/lib/portalVisitProgress.ts`), so an
 * installed app that predates this still decodes it. Every pill, the detail
 * screen's Status row and the live card read the stage through [stage], never
 * [Booking.status] alone, so a departed visit cannot read IN PROGRESS on one
 * screen and DEPARTED on another. The web portal's `visitStageOf` is the same
 * rule.
 */
enum class VisitStage { Requested, Confirmed, EnRoute, Active, Departed, Completed, Cancelled }

fun Booking.stage(): VisitStage = when (status) {
    BookingStatus.Requested -> VisitStage.Requested
    BookingStatus.Confirmed -> VisitStage.Confirmed
    BookingStatus.EnRoute -> VisitStage.EnRoute
    BookingStatus.Active -> if (visitProgress == VisitProgress.Ended) VisitStage.Departed else VisitStage.Active
    BookingStatus.Completed -> VisitStage.Completed
    BookingStatus.Cancelled -> VisitStage.Cancelled
}

/**
 * The one wording of a visit's stage, for the list pill, the Home pill and the
 * detail screen alike. The web portal's `bookingStatusChip` says the same
 * seven words.
 */
fun VisitStage.label(): String = when (this) {
    VisitStage.Requested -> "REQUESTED"
    VisitStage.Confirmed -> "CONFIRMED"
    VisitStage.EnRoute -> "EN ROUTE"
    VisitStage.Active -> "IN PROGRESS"
    VisitStage.Departed -> "DEPARTED"
    VisitStage.Completed -> "COMPLETED"
    VisitStage.Cancelled -> "CANCELLED"
}

/** On the way, arrived or departed: the Auntie has started and the visit is not finished. */
fun Booking.isUnderWay(): Boolean = when (stage()) {
    VisitStage.EnRoute, VisitStage.Active, VisitStage.Departed -> true
    else -> false
}

/**
 * The visit the live card is about, or null. The server's `liveVisit`, checked
 * again here: an older answer that still names a departed visit must not keep
 * the card up after the Auntie has left.
 */
fun BookingsResult.liveVisitOrNull(): Booking? =
    liveVisit?.takeIf { it.stage() == VisitStage.EnRoute || it.stage() == VisitStage.Active }

/**
 * Finds one visit by id: where every visit notice lands.
 *
 * The lists first, then the envelopes. Upcoming and Past Visits are what
 * belongs on a list today (Past Visits is the latest ten), so a visit can be on
 * neither and still be the household's; the envelopes carry every visit it has.
 * The server answers for the signed-in household only, so another household's
 * visit is in none of them and comes back null.
 */
fun BookingsResult.findBooking(id: String): Booking? =
    liveVisit?.takeIf { it.id == id }
        ?: (upcoming + recent).firstOrNull { it.id == id }
        ?: envelopes.firstNotNullOfOrNull { e -> e.kinCares.firstOrNull { it.id == id } }

/** How often the schedule is re-read while a visit could change under the household's eyes. */
const val BOOKINGS_POLL_MS: Long = 30_000L

/** A confirmed visit is watched from this long before its start. */
private const val POLL_LEAD_MS: Long = 60L * 60L * 1000L

/**
 * Whether the schedule should be kept current right now: a visit is under way,
 * or a confirmed one is within the hour before its start or past it (the
 * Auntie's first tap is the one a rule of "under way only" would never see).
 * False otherwise, so a household with nothing due today costs no reads.
 *
 * There is no listener to use instead: the visit's progress lives on the
 * AuntieOS session, which the rules do not let a household read (#584).
 */
fun BookingsResult?.isBeingFollowed(nowMs: Long): Boolean {
    if (this == null) return false
    return (listOfNotNull(liveVisit) + upcoming).any { b ->
        val start = b.startTimeMs
        b.isUnderWay() || (b.status == BookingStatus.Confirmed && start != null && start - POLL_LEAD_MS <= nowMs)
    }
}
