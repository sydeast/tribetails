package com.kinfolk.portal.screens.schedule

import com.kinfolk.portal.portal.BookingMode
import com.kinfolk.portal.portal.BookingPolicy
import com.kinfolk.portal.portal.BookingVisit
import com.kinfolk.portal.portal.Service
import com.kinfolk.portal.portal.TimeBlock
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
    /** "HH:MM", local to the household. Read in [BookingMode.SpecificTime]. */
    val time: String,
    /**
     * Time-block booking: the named window this KinCare was asked for. Read in
     * [BookingMode.TimeBlock]; null there means the household has not chosen
     * one yet.
     *
     * BOTH fields live on the slot at once, deliberately. The MODE is a
     * booking-level choice (see [BookingTiming]) — the operator asked for
     * blocks instead of clocks, not for a per-KinCare mixture — so switching
     * mode must not discard what was already typed on the other control. What
     * is SENT is decided by the mode, never by which field happens to be set.
     */
    val timeBlockId: String? = null,
)

/**
 * Time-block booking, client half. Operator requirement 2026-08-24: "kinfolk
 * book within time blocks, not at a specific set time."
 *
 * The MODE is booking-level and the WINDOW is per-KinCare, which is the shape
 * the requirement actually has: a day may hold several KinCares (#541/#543), so
 * a household may want the 30-minute one in Midday and the 60-minute one in
 * Evening, or two different KinCares in the same window. What it never wants is
 * one KinCare on the clock and the next one in a window.
 *
 * The web mirror is `BookingTiming` in mytribe/web/src/lib/bookingWizardLogic.ts.
 */
data class BookingTiming(
    val mode: BookingMode,
    /** Empty in SpecificTime mode, and never empty in TimeBlock mode. */
    val blocks: List<TimeBlock> = emptyList(),
) {
    companion object {
        /** The pre-time-block world: clock times, no windows. The default every existing caller gets. */
        val SpecificTimeOnly = BookingTiming(BookingMode.SpecificTime, emptyList())
    }
}

/**
 * Which mode the wizard opens on, and which the household may switch to.
 *
 * Reads the SERVER-NORMALIZED policy and nothing else: `getBookingPolicy`
 * already resolved "block booking on but no usable window" down to block
 * booking off, and "neither mode allowed" down to specific time, so there is no
 * combination left here that renders an empty screen.
 */
fun initialBookingMode(policy: BookingPolicy): BookingMode = when {
    !policy.allowTimeBlockBooking -> BookingMode.SpecificTime
    !policy.allowSpecificTimeBooking -> BookingMode.TimeBlock
    else -> policy.defaultBookingMode
}

/** The window with this id, or null. */
fun findTimeBlock(blocks: List<TimeBlock>, id: String?): TimeBlock? =
    if (id == null) null else blocks.firstOrNull { it.id == id }

/** "Midday (11:00 – 15:00)" — how a window is named wherever one is chosen or confirmed. */
fun timeBlockLabel(block: TimeBlock): String = "${block.label} (${block.startTime} – ${block.endTime})"

/**
 * The "HH:MM" a slot actually starts at under [timing], or null when it has
 * nothing usable yet.
 *
 * In TimeBlock mode a visit starts at its window's FIRST MINUTE. That is not a
 * pretence that the Auntie arrives at 11:00 sharp — it is the only instant the
 * whole window is derivable from, it is what AuntieOS's own containment
 * resolver labels back as "Midday block", and the block id travels beside it so
 * the office reads the household's answer rather than inferring it.
 */
private fun slotStartHHmm(slot: KinCareSlot, timing: BookingTiming): String? =
    if (timing.mode == BookingMode.TimeBlock) {
        findTimeBlock(timing.blocks, slot.timeBlockId)?.startTime
    } else {
        if (parseHourMinuteOrNull(slot.time) == null) null else slot.time
    }

/** Chronological, so the plan a household reads runs down the day. Ties broken by service for determinism. */
private fun slotOrder(slots: List<KinCareSlot>, timing: BookingTiming): List<KinCareSlot> =
    slots.sortedWith(compareBy({ slotStartHHmm(it, timing) ?: "" }, { it.serviceId }))

/**
 * First blocking reason for the KinCare list, or null when it is sendable. Pure.
 *
 * The duplicate rule is the one worth reading twice: two slots with the same
 * duration AND the same time are not "two KinCares in a day", they are one
 * KinCare asked for twice, and `requestBooking` refuses them. Saying so here
 * means a household finds out while they can still fix it.
 */
fun slotsBlocker(
    slots: List<KinCareSlot>,
    timing: BookingTiming = BookingTiming.SpecificTimeOnly,
): String? {
    if (slots.isEmpty()) return "Add at least one KinCare Duration."
    if (timing.mode == BookingMode.TimeBlock) {
        if (slots.any { findTimeBlock(timing.blocks, it.timeBlockId) == null }) {
            return "Choose a time block for every KinCare."
        }
        val seenBlocks = HashSet<String>()
        for (s in slots) {
            // The duplicate rule, in block words. In block mode every KinCare
            // in a window starts at the same instant, so "same duration at the
            // same time" would refuse the perfectly good "a 30 minute AND a 60
            // minute, both in Midday" — and would say so next to a picker that
            // has no times in it. What is actually one KinCare asked for twice
            // is the same duration in the same window, and that is what both
            // this and `requestBooking`'s server-side guard refuse.
            if (!seenBlocks.add("${s.serviceId}@block:${s.timeBlockId}")) {
                return "Two KinCares are the same duration in the same time block. Remove one, or move it to another block."
            }
        }
        return null
    }
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
fun weeklyVisitsBlocker(
    weeklyDays: Set<Int>,
    weeks: Int,
    slots: List<KinCareSlot>,
    timing: BookingTiming = BookingTiming.SpecificTimeOnly,
): String? {
    if (weeklyDays.isEmpty()) return "Pick at least one day of the week."
    if (weeks < 1) return "Choose how many weeks."
    return slotsBlocker(slots, timing)
}

/**
 * One visit for [slot] on calendar day [d], or null when the slot's service
 * left the catalog or it has no usable start yet.
 *
 * `priceCents` still comes from the SERVICE, in both modes. A block says WHEN a
 * visit happens; the KinCare says how long it runs and what it costs, and the
 * server re-resolves the price from the same catalog either way. Nothing about
 * time-block booking touches the money.
 */
private fun slotVisitOn(
    d: LocalDate,
    slot: KinCareSlot,
    services: List<Service>,
    tz: TimeZone,
    timing: BookingTiming,
): BookingVisit? {
    val service = services.firstOrNull { it.id == slot.serviceId } ?: return null
    val t = parseHourMinuteOrNull(slotStartHHmm(slot, timing) ?: return null) ?: return null
    val dt = LocalDateTime(d.year, d.month, d.dayOfMonth, t.hour, t.minute)
    return BookingVisit(
        startTimeMs = dt.toInstant(tz).toEpochMilliseconds(),
        endTimeMs = null,
        serviceId = service.id,
        serviceName = service.name,
        priceCents = service.priceCents ?: service.priceMinCents,
        timeBlockId = if (timing.mode == BookingMode.TimeBlock) slot.timeBlockId else null,
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
    timing: BookingTiming = BookingTiming.SpecificTimeOnly,
): List<BookingVisit> {
    if (weeklyDays.isEmpty() || weeks < 1 || slots.isEmpty()) return emptyList()
    val ordered = slotOrder(slots, timing)
    val today = Instant.fromEpochMilliseconds(nowMs).toLocalDateTime(tz).date
    val out = ArrayList<BookingVisit>()
    val totalDays = weeks * 7
    var offset = 0
    while (offset < totalDays && out.size < MAX_RECURRING_VISITS) {
        val d = today.plus(offset, DateTimeUnit.DAY)
        if (weekdayIndex(d) in weeklyDays) {
            for (slot in ordered) {
                if (out.size >= MAX_RECURRING_VISITS) break
                val visit = slotVisitOn(d, slot, services, tz, timing)
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
    timing: BookingTiming = BookingTiming.SpecificTimeOnly,
): List<BookingVisit> {
    val out = ArrayList<BookingVisit>()
    for (d in dates) {
        for (slot in slots) {
            slotVisitOn(d, slot, services, tz, timing)?.let { out.add(it) }
        }
    }
    return out.sortedWith(compareBy({ it.startTimeMs }, { it.serviceId }))
}

/**
 * Visits in the plan whose start has ALREADY PASSED.
 *
 * `requestBooking` refuses any visit starting more than a minute ago, and the
 * Individual pattern has never filtered for it (only the weekly expansion
 * does) — so a household that taps today and leaves the time at 09:00 in the
 * afternoon gets the whole request refused at Create Booking with no earlier
 * warning. Time blocks make that a certainty rather than a mistake: a window
 * offers ONE start time, so once today's Midday window has opened, every
 * Midday visit placed on today is in the past by construction and the
 * household has no control to nudge. So the plan says so while it can still be
 * fixed, in both modes. Pure ([nowMs] injected).
 */
fun pastPlannedVisits(visits: List<BookingVisit>, nowMs: Long): List<BookingVisit> =
    visits.filter { it.startTimeMs <= nowMs }

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
    /**
     * "Midday (11:00 – 15:00)" when the visit was booked into a named window,
     * null when it was booked on the clock. When set it REPLACES the time in
     * [plannedVisitLine]: the household chose a window, and printing
     * "11:00 AM" back at them would be reporting a precision they never gave.
     */
    val timeBlockLabel: String? = null,
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
    blocks: List<TimeBlock> = emptyList(),
): List<RenderedPlannedVisit> = visits.sortedBy { it.startTimeMs }.map { v ->
    val dt = Instant.fromEpochMilliseconds(v.startTimeMs).toLocalDateTime(tz)
    val hour12 = when (val h = dt.hour % 12) {
        0 -> 12
        else -> h
    }
    val minute = if (dt.minute < 10) "0${dt.minute}" else dt.minute.toString()
    val block = findTimeBlock(blocks, v.timeBlockId)
    RenderedPlannedVisit(
        weekday = WEEKDAY_ABBR[dt.date.dayOfWeek.ordinal],
        date = "${MONTH_ABBR[dt.date.month.ordinal]} ${dt.date.day}",
        time = "$hour12:$minute ${if (dt.hour < 12) "AM" else "PM"}",
        serviceName = v.serviceName,
        // Two KinCares of one duration in one day are told apart by the time in
        // clock mode and by the window in block mode, where every start is equal.
        key = "${v.startTimeMs}-${v.serviceId}-${v.timeBlockId ?: ""}",
        timeBlockLabel = block?.let { timeBlockLabel(it) },
    )
}

/**
 * "Thu, Sep 4 at 9:00 AM" — the spec's own one-line spelling of a visit — or
 * "Thu, Sep 4 · Midday (11:00 – 15:00)" when the household picked a window
 * instead of a clock. The date half is unchanged in both: the enumeration rule
 * is about WHICH DAYS, and a block does not make a day any less specific.
 */
fun plannedVisitLine(v: RenderedPlannedVisit): String =
    if (v.timeBlockLabel != null) {
        "${v.weekday}, ${v.date} · ${v.timeBlockLabel}"
    } else {
        "${v.weekday}, ${v.date} at ${v.time}"
    }

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
