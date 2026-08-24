package com.kinfolk.portal.screens.schedule

import com.kinfolk.portal.portal.BookingVisit
import com.kinfolk.portal.portal.Service
import com.kinfolk.portal.util.formatUsd
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.LocalTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.plus
import kotlinx.datetime.toInstant
import kotlinx.datetime.toLocalDateTime
import kotlin.time.Instant

// ─────────────────────────────────────────────────────────────────────────────
// Recurring (weekly) visit expansion (16.3). PURE + unit-tested: expands a weekly
// rule (which weekdays, for N weeks, at a time) into the explicit BookingVisit[]
// that requestBooking expects (the callable stores pattern/weeklyDays but does NOT
// expand dates server-side, so the client owns expansion - and doing it client-side
// keeps the kinfolk's local timezone correct). No new callable: this feeds the
// existing requestBookingMultiVisit(pattern=Weekly, weeklyDays, visits).
// ─────────────────────────────────────────────────────────────────────────────

/** Hard cap so a runaway rule can never create a huge batch. */
const val MAX_RECURRING_VISITS = 26

/** Day index 0=Sun..6=Sat (matches the server's weeklyDays 0-6). Pure. */
internal fun weekdayIndex(d: LocalDate): Int = (d.dayOfWeek.ordinal + 1) % 7

/** Parses "HH:MM" to a LocalTime, or null. Pure. */
fun parseHourMinuteOrNull(s: String): LocalTime? = try {
    val p = s.split(":")
    if (p.size != 2) null else LocalTime(p[0].trim().toInt(), p[1].trim().toInt())
} catch (_: Throwable) {
    null
}

/**
 * #541 + #543: ONE KinCare inside a booking day.
 *
 * The wizard used to carry one `selectedServiceId` and one `visitTime`, which
 * is exactly two things it could not express: two DIFFERENT durations in a day
 * (#541) and two KinCares of the SAME duration in a day (#543, the midday and
 * the evening walk). Both are one shape: a booking day is a LIST of KinCares,
 * and what separates two entries of the same duration is the time of day. So a
 * slot carries its own time, and the plan is `dates x slots`.
 *
 * [slotId] is local to the screen (Compose `key`, and telling two identical
 * rows apart while one is edited). It is never sent.
 *
 * The web mirror is `KinCareSlot` in mytribe/web/src/lib/bookingWizardLogic.ts.
 */
data class KinCareSlot(
    val slotId: String,
    val serviceId: String,
    /** "HH:MM", local to the household. */
    val time: String,
)

/** Chronological, so the plan a household reads runs down the day. Ties broken by service for determinism. */
private fun slotOrder(slots: List<KinCareSlot>): List<KinCareSlot> =
    slots.sortedWith(compareBy({ it.time }, { it.serviceId }))

/**
 * First blocking reason for the KinCare list, or null when it is sendable. Pure.
 *
 * The duplicate rule is the one worth reading twice: two slots with the same
 * duration AND the same time are not "two KinCares in a day", they are one
 * KinCare asked for twice, and `requestBooking` refuses them. Saying so here
 * means a household finds out while they can still fix it.
 */
fun slotsBlocker(slots: List<KinCareSlot>): String? {
    if (slots.isEmpty()) return "Add at least one KinCare Duration."
    if (slots.any { parseHourMinuteOrNull(it.time) == null }) return "Enter every KinCare time as HH:MM."
    val seen = HashSet<String>()
    for (s in slots) {
        if (!seen.add("${s.serviceId}@${s.time}")) {
            return "Two KinCares have the same duration at the same time. Change one of the times."
        }
    }
    return null
}

/**
 * The number of visits a weekly rule INTENDS to create (days x weeks x
 * KinCares), ignoring the future-only filter + the cap. Used to detect +
 * surface cap truncation so it is never silent. Pure.
 */
fun weeklyPotentialCount(weeklyDays: Set<Int>, weeks: Int, slotCount: Int): Int =
    if (weeks < 1) 0 else weeklyDays.size * weeks * slotCount

/** First blocking reason for a weekly rule, or null when it is sendable. Pure. */
fun weeklyVisitsBlocker(weeklyDays: Set<Int>, weeks: Int, slots: List<KinCareSlot>): String? {
    if (weeklyDays.isEmpty()) return "Pick at least one day of the week."
    if (weeks < 1) return "Choose how many weeks."
    return slotsBlocker(slots)
}

/** One visit for [slot] on calendar day [d], or null when the slot's service left the catalog. */
private fun slotVisitOn(d: LocalDate, slot: KinCareSlot, services: List<Service>, tz: TimeZone): BookingVisit? {
    val service = services.firstOrNull { it.id == slot.serviceId } ?: return null
    val t = parseHourMinuteOrNull(slot.time) ?: return null
    val dt = LocalDateTime(d.year, d.month, d.dayOfMonth, t.hour, t.minute)
    return BookingVisit(
        startTimeMs = dt.toInstant(tz).toEpochMilliseconds(),
        endTimeMs = null,
        serviceId = service.id,
        serviceName = service.name,
        priceCents = service.priceCents ?: service.priceMinCents,
    )
}

/**
 * Expands a weekly rule into concrete future BookingVisits. Walks each calendar
 * day from "now" for [weeks] weeks, emitting ONE VISIT PER KinCare SLOT for
 * every day whose weekday is in [weeklyDays] and whose datetime is strictly in
 * the future (so the server's past-start rejection never trips). Capped at
 * [MAX_RECURRING_VISITS]. Pure (now is injected as [nowMs]) so it is
 * deterministic + unit-testable.
 *
 * The cap counts VISITS, not days: three KinCares a day for four weeks of
 * Mondays is 12 visits. Slots are walked in time order inside each day so the
 * run that survives the cap is the chronologically earliest one, never an
 * arbitrary slice of the middle.
 */
fun buildWeeklyVisits(
    nowMs: Long,
    weeklyDays: Set<Int>,
    weeks: Int,
    slots: List<KinCareSlot>,
    services: List<Service>,
    tz: TimeZone = TimeZone.currentSystemDefault(),
): List<BookingVisit> {
    if (weeklyDays.isEmpty() || weeks < 1 || slots.isEmpty()) return emptyList()
    val ordered = slotOrder(slots)
    val today = Instant.fromEpochMilliseconds(nowMs).toLocalDateTime(tz).date
    val out = ArrayList<BookingVisit>()
    val totalDays = weeks * 7
    var offset = 0
    while (offset < totalDays && out.size < MAX_RECURRING_VISITS) {
        val d = today.plus(offset, DateTimeUnit.DAY)
        if (weekdayIndex(d) in weeklyDays) {
            for (slot in ordered) {
                if (out.size >= MAX_RECURRING_VISITS) break
                val visit = slotVisitOn(d, slot, services, tz)
                if (visit != null && visit.startTimeMs > nowMs) out.add(visit)
            }
        }
        offset++
    }
    return out
}

/**
 * Expands the Individual-pattern tapped dates into visits: one per date PER
 * KinCare SLOT, each at its own slot time. Sorted by start time, which is both
 * what a household reads on Review and the order the envelope's
 * firstStartTime / lastStartTime rollup wants. Pure.
 */
fun buildVisits(
    dates: List<LocalDate>,
    slots: List<KinCareSlot>,
    services: List<Service>,
    tz: TimeZone = TimeZone.currentSystemDefault(),
): List<BookingVisit> {
    val out = ArrayList<BookingVisit>()
    for (d in dates) {
        for (slot in slots) {
            slotVisitOn(d, slot, services, tz)?.let { out.add(it) }
        }
    }
    return out.sortedWith(compareBy({ it.startTimeMs }, { it.serviceId }))
}

/**
 * #546 / #547: what a booking is estimated to cost, computed from the ACTUAL
 * visit list.
 *
 * The old estimate was `priceLabel(selectedService)` — the catalog's per-visit
 * sticker price, printed unchanged next to a plan of three visits. It could not
 * go wrong, because it never read the plan: it said $25.00 whether the
 * household had picked no dates, one date, or three. That is #546, and #547's
 * "price still didn't update" is the same string on Review.
 *
 * A price that cannot be known is counted, never guessed: [floorVisits] are
 * priced from a range minimum (their real price can only be higher) and
 * [unpricedVisits] carry no catalog price at all and add nothing.
 */
data class BookingEstimate(
    /** Sum of every KNOWN per-visit price, in cents. */
    val totalCents: Long,
    /** Visits whose service has a fixed price: the total is exact for these. */
    val exactVisits: Int,
    /** Visits priced from a range minimum. */
    val floorVisits: Int,
    /** Visits whose service carries no price at all. */
    val unpricedVisits: Int,
)

fun estimateBookingTotal(visits: List<BookingVisit>, services: List<Service>): BookingEstimate {
    var totalCents = 0L
    var exact = 0
    var floor = 0
    var unpriced = 0
    for (v in visits) {
        val service = services.firstOrNull { it.id == v.serviceId }
        val fixed = service?.priceCents
        val min = service?.priceMinCents
        when {
            fixed != null -> { totalCents += fixed; exact++ }
            min != null -> { totalCents += min; floor++ }
            else -> unpriced++
        }
    }
    return BookingEstimate(totalCents, exact, floor, unpriced)
}

/**
 * The estimate as a household reads it: "$75.00", "from $75.00" when part of
 * the plan can only be bounded below, "Pending" when nothing in it is priced,
 * and an em dash for an empty plan. Never invents a number.
 */
fun formatEstimate(e: BookingEstimate): String {
    val total = e.exactVisits + e.floorVisits + e.unpricedVisits
    if (total == 0) return "—"
    if (e.exactVisits == 0 && e.floorVisits == 0) return "Pending"
    val money = formatUsd(e.totalCents / 100.0)
    return if (e.floorVisits > 0 || e.unpricedVisits > 0) "from $money" else money
}

/** "Thu" / "Sep 4" / "9:00 AM" — the spec's own spellings, see [renderPlannedVisits]. */
private val WEEKDAY_ABBR = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
private val MONTH_ABBR = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** One planned visit, formatted for a kinfolk-facing list. */
data class RenderedPlannedVisit(
    val weekday: String,
    val date: String,
    val time: String,
    val serviceName: String,
    val key: String,
)

/**
 * #547: the chosen dates, ENUMERATED.
 *
 * Review used to print "3 visits" and stop, which is precisely the summarising
 * `docs/superpowers/specs/2026-08-23-visit-date-rendering-design.md` rules out:
 * a count says nothing about WHICH days, and four Thursdays across a month read
 * as a four-day block. The spelling below is the spec's own — "Thu", "Sep 4",
 * "9:00 AM" — so the wizard and the messages a household later receives name
 * the same day the same way.
 *
 * ONE DELIBERATE DIFFERENCE the spec does not cover: it formats server-side in
 * `business_settings.timeZone`, because a message is composed for a recipient
 * who is not there. This list is rendered in the DEVICE's zone, from dates the
 * household just tapped on their own calendar — formatting those in the
 * business's zone could show them a day they did not pick. The spec governs
 * messages; this is the wizard.
 */
fun renderPlannedVisits(
    visits: List<BookingVisit>,
    tz: TimeZone = TimeZone.currentSystemDefault(),
): List<RenderedPlannedVisit> = visits.sortedBy { it.startTimeMs }.map { v ->
    val dt = Instant.fromEpochMilliseconds(v.startTimeMs).toLocalDateTime(tz)
    val hour12 = when (val h = dt.hour % 12) {
        0 -> 12
        else -> h
    }
    val minute = if (dt.minute < 10) "0${dt.minute}" else dt.minute.toString()
    RenderedPlannedVisit(
        weekday = WEEKDAY_ABBR[dt.date.dayOfWeek.ordinal],
        date = "${MONTH_ABBR[dt.date.month.ordinal]} ${dt.date.day}",
        time = "$hour12:$minute ${if (dt.hour < 12) "AM" else "PM"}",
        serviceName = v.serviceName,
        key = "${v.startTimeMs}-${v.serviceId}",
    )
}

/** "Thu, Sep 4 at 9:00 AM" — the spec's own one-line spelling of a visit. */
fun plannedVisitLine(v: RenderedPlannedVisit): String = "${v.weekday}, ${v.date} at ${v.time}"

/**
 * The KinCare list as the summary says it: "2 × 30 Minute, 1 × 60 Minute",
 * counted rather than repeated, in the order the durations were first added.
 */
fun summariseSlots(slots: List<KinCareSlot>, services: List<Service>): String {
    val order = ArrayList<String>()
    val counts = LinkedHashMap<String, Int>()
    for (s in slots) {
        if (!counts.containsKey(s.serviceId)) order.add(s.serviceId)
        counts[s.serviceId] = (counts[s.serviceId] ?: 0) + 1
    }
    return order.joinToString(", ") { id ->
        val name = services.firstOrNull { it.id == id }?.name ?: id
        val n = counts[id] ?: 0
        if (n > 1) "$n × $name" else name
    }
}
