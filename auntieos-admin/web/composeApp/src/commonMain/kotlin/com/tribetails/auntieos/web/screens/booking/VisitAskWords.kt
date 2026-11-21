@file:OptIn(kotlin.time.ExperimentalTime::class)

package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.AskDecision
import com.tribetails.auntieos.web.data.CancelAsk
import com.tribetails.auntieos.web.data.CancelAskAnswer
import com.tribetails.auntieos.web.data.RescheduleAsk
import com.tribetails.auntieos.web.data.RescheduleAskAnswer
import com.tribetails.auntieos.web.screens.ServiceCatalog
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * #2243: a household's ask on a visit that is already booked, whichever kind it
 * is. The words below are admin web's (`components/VisitRequestsSection.tsx`)
 * so the office reads the same sentence on every client. Pure; unit-tested.
 */
sealed interface VisitAsk {
    val kinfolkId: String
    val batchId: String
    val visitId: String
    val kinfolkName: String?
    val title: String?
    val serviceType: String?
    val kinNames: List<String>
    val reason: String?
    val requestedAtMs: Long?

    data class Reschedule(val ask: RescheduleAsk) : VisitAsk {
        override val kinfolkId get() = ask.kinfolkId
        override val batchId get() = ask.batchId
        override val visitId get() = ask.visitId
        override val kinfolkName get() = ask.kinfolkName
        override val title get() = ask.title
        override val serviceType get() = ask.serviceType
        override val kinNames get() = ask.kinNames
        override val reason get() = ask.reason
        override val requestedAtMs get() = ask.requestedAtMs
    }

    data class Cancel(val ask: CancelAsk) : VisitAsk {
        override val kinfolkId get() = ask.kinfolkId
        override val batchId get() = ask.batchId
        override val visitId get() = ask.visitId
        override val kinfolkName get() = ask.kinfolkName
        override val title get() = ask.title
        override val serviceType get() = ask.serviceType
        override val kinNames get() = ask.kinNames
        override val reason get() = ask.reason
        override val requestedAtMs get() = ask.requestedAtMs
    }
}

/**
 * The row's identity. A visit id is only unique inside its household, and a
 * visit can carry both asks at once, so the kind is part of it.
 */
fun VisitAsk.key(): String {
    val kind = if (this is VisitAsk.Cancel) "cancel" else "reschedule"
    return "$kind/$kinfolkId/$batchId/$visitId"
}

/**
 * Newest first (#1607): the newest ask is the one the office has not seen yet.
 * An ask with no time sorts last, since it is neither the newest nor the oldest.
 */
fun mergeVisitAsks(reschedule: List<RescheduleAsk>, cancel: List<CancelAsk>): List<VisitAsk> =
    (reschedule.map { VisitAsk.Reschedule(it) } + cancel.map { VisitAsk.Cancel(it) })
        .sortedByDescending { it.requestedAtMs ?: Long.MIN_VALUE }

private val ASK_MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/**
 * An instant on the business clock, the auntieOS way (ruling 2026-11-12): the
 * month as a word and a 24-hour clock, "Nov 10, 2026 22:32". "Not set" when the
 * ask carries no time.
 */
fun askTimeLabel(ms: Long?, zone: TimeZone): String {
    if (ms == null) return "Not set"
    val t = Instant.fromEpochMilliseconds(ms).toLocalDateTime(zone)
    val hour = t.hour.toString().padStart(2, '0')
    val minute = t.minute.toString().padStart(2, '0')
    return "${ASK_MONTHS[t.month.ordinal]} ${t.day}, ${t.year} $hour:$minute"
}

/** What the row calls itself in the queue. */
fun VisitAsk.kindLabel(): String = if (this is VisitAsk.Cancel) "Cancel" else "Reschedule"

/** WHO is asking (#1577). */
fun VisitAsk.householdLabel(): String = kinfolkName?.trim()?.ifEmpty { null } ?: HOUSEHOLD_NOT_ON_FILE

private fun VisitAsk.forHousehold(preposition: String): String =
    kinfolkName?.trim()?.takeIf { it.isNotEmpty() }?.let { " $preposition $it" }.orEmpty()

/** The visit's KinCare name, or null when the visit carries none. */
private fun VisitAsk.serviceOrNull(catalog: ServiceCatalog): String? =
    title?.trim()?.takeIf { it.isNotEmpty() }
        ?: serviceType?.trim()?.takeIf { it.isNotEmpty() }?.let { catalog.nameOf(it) }

/** What the ask is about: the service, then the Kin it covers. */
fun VisitAsk.subject(catalog: ServiceCatalog = ServiceCatalog()): String {
    val service = serviceOrNull(catalog) ?: "Visit"
    val kin = kinNames.filter { it.isNotBlank() }.joinToString(", ")
    return if (kin.isEmpty()) service else "$service · $kin"
}

/** The Service fact in the detail sheet. */
fun VisitAsk.serviceFact(catalog: ServiceCatalog = ServiceCatalog()): String = serviceOrNull(catalog) ?: "Not on the visit"

/** A move shows both times; a cancellation shows the visit it would take off the books. */
fun VisitAsk.whenLine(zone: TimeZone): String = when (this) {
    is VisitAsk.Cancel -> askTimeLabel(ask.startTimeMs, zone)
    is VisitAsk.Reschedule -> "${askTimeLabel(ask.currentStartTimeMs, zone)} → ${askTimeLabel(ask.proposedStartTimeMs, zone)}"
}

/** The detail sheet's title. */
fun VisitAsk.detailTitle(): String = "${kindLabel()}${forHousehold("from")}"

/** The confirm step's title names the household, so nobody answers the wrong one (#1577). */
fun VisitAsk.decisionTitle(decision: AskDecision): String = when (this) {
    is VisitAsk.Cancel ->
        if (decision == AskDecision.DECLINE) "Keep this visit${forHousehold("for")}" else "Cancel this visit${forHousehold("for")}"
    is VisitAsk.Reschedule ->
        if (decision == AskDecision.DECLINE) "Decline this new time${forHousehold("from")}" else "Move this visit${forHousehold("for")}"
}

/** What answering will do, in the future tense. */
fun VisitAsk.decisionLine(decision: AskDecision, zone: TimeZone): String = when (this) {
    is VisitAsk.Cancel -> {
        val whenText = askTimeLabel(ask.startTimeMs, zone)
        if (decision == AskDecision.DECLINE) "$whenText stays on the schedule. The household will be told it is going ahead."
        else "$whenText will be taken off the schedule and off the household's portal."
    }
    is VisitAsk.Reschedule -> {
        val current = askTimeLabel(ask.currentStartTimeMs, zone)
        val proposed = askTimeLabel(ask.proposedStartTimeMs, zone)
        if (decision == AskDecision.DECLINE) "$proposed will not be booked. The visit stays at $current."
        else "This visit will move from $current to $proposed."
    }
}

/** The confirm button never repeats the trigger's label. */
fun VisitAsk.confirmLabel(decision: AskDecision): String = when {
    decision == AskDecision.DECLINE -> "Send the decline"
    this is VisitAsk.Cancel -> "Cancel it"
    else -> "Move it"
}

/** The note box's label. */
fun askNoteLabel(decision: AskDecision): String =
    if (decision == AskDecision.DECLINE) "Anything to add for the household (optional)" else "Note for the household (optional)"

/** What a move answer did, from what the server says it did. */
fun rescheduleAnsweredMessage(decision: AskDecision, answer: RescheduleAskAnswer): String = when {
    decision == AskDecision.DECLINE -> "Declined. The household will see your answer on their booking."
    answer.sessionUpdated -> "Moved. The schedule and the household now show the new time."
    else -> "Moved. This visit is still a request, so it has no schedule row to move yet."
}

/** What a cancellation answer did, from what the server says it did. */
fun cancelAnsweredMessage(decision: AskDecision, answer: CancelAskAnswer): String = when {
    decision == AskDecision.DECLINE -> "Declined. The visit stays on the schedule and the household gets your answer."
    answer.sessionUpdated -> "Cancelled. It is off the schedule and off the household’s portal."
    else -> "Cancelled. This visit was still a request, so it had no schedule row to take off."
}

/** The outcome banner names who the answer was for (#1577). */
fun VisitAsk.outcomeLine(message: String): String = "${householdLabel()}: $message"

/** Per queue, the line that says it did not load, so a failed queue never reads as empty. */
const val RESCHEDULE_QUEUE_NAME = "Reschedule requests"
const val CANCEL_QUEUE_NAME = "Cancellation requests"

fun askQueueFailureText(failures: List<String>): String =
    "${failures.joinToString(" ")} Anything waiting there is not on this list."
