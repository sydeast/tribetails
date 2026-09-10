package com.tribetails.auntieos.domain

import androidx.annotation.Keep
import com.tribetails.auntieos.ui.admin.serviceOptionsFromRates
import java.time.LocalDate
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.Locale
import java.util.UUID
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Coverage Package Builder — pure domain logic. Android port of the web
 * `lib/coveragePackage.ts` (the full PackageBuilder_7 model), kept behaviour-
 * identical so a menu saved on one platform prices the same on the other.
 *
 * An operator BUILDS one or more named packages: each a template of visits (any
 * mix of lengths/times), with per-night overnights, per-day overrides, and an
 * optional discount. Suggestions seed a package from a rule; every seeded visit
 * is editable. No pinned visit or auto-filled gap is required — the operator can
 * simply pick services for a client.
 *
 * Pricing: an overnight is a WINDOW, not a line item — a visit inside the window
 * (or its arrival buffer) is covered ($0); an overnight also grants one free visit
 * the next day, stacked on top.
 *
 * [Duration], [PinnedTime], [CoverageRules] double as the Firestore wire model
 * (var + defaults + @Keep). [Visit]/[Package] and the priced/coverage types are
 * derived UI state, never persisted to Firestore.
 */

/** A named service length with its price. `kind` splits day visits from overnights. */
@Keep
data class Duration(
    var id: String = "",
    var label: String = "",
    var minutes: Double = 0.0,
    var price: Double = 0.0,
    var kind: String = "visit",
)

/** A visit that must happen at a fixed "HH:MM" time every covered day. */
@Keep
data class PinnedTime(
    var id: String = "",
    var label: String = "",
    var time: String = "",
    var durationId: String = "",
)

/** The per-client coverage rules — seed the suggestions and gap warnings. */
@Keep
data class CoverageRules(
    var wakeStart: String = "07:00",
    var wakeEnd: String = "22:00",
    var maxGapHours: Double = 6.0,
    var pinnedTimes: List<PinnedTime> = emptyList(),
)

/** One scheduled visit inside a package. `time` is minutes since midnight. */
data class Visit(
    val id: String,
    val time: Int,
    val durationId: String,
    val label: String,
)

/** A named package: a visit template + per-night overnights + optional per-day overrides. */
data class Package(
    val id: String,
    val name: String,
    val visits: List<Visit> = emptyList(),
    val dayOverrides: Map<Int, List<Visit>> = emptyMap(),
    val overnightNights: Map<Int, Boolean> = emptyMap(),
    val overnightStart: String = "21:00",
    val overnightBufferHours: Double = 2.0,
    val discountLabel: String = "",
    val discountPct: Double = 0.0,
    /**
     * One line on the card saying this package's tier could not meet the client's
     * rules as written and what it did instead. "" on a hand-built package and on
     * a tier that met them.
     */
    val note: String = "",
)

/** One visit inside a generated suggestion (pinned or gap-filling check-in). */
data class Touchpoint(
    val isPinned: Boolean,
    val label: String,
    val time: Double,
    val durationId: String,
    val durationLabel: String,
    val price: Double,
)

/** One tier's day schedule at one price point (Lean, Balance or Premium). */
data class DayPattern(
    val id: String,
    val strategyLabel: String,
    val touchpoints: List<Touchpoint>,
    val dayTotal: Double,
    val signature: String,
    /**
     * One line saying the rules could not be met as written and what this tier did
     * instead. "" when the tier satisfies the wake window and the max-gap rule.
     */
    val note: String = "",
)

/** What an overnight covers on a given day. */
data class Coverage(
    val eveningFrom: Int?,
    val morningUntil: Int?,
    val bonusFreeVisit: Boolean,
)

private val BARE_COVERAGE = Coverage(null, null, false)

/** One priced visit line. */
data class PricedItem(
    val key: String,
    val time: Int,
    val label: String,
    val durationLabel: String,
    val price: Double,
    val listPrice: Double,
    val covered: Boolean,
    val bonus: Boolean,
    val free: Boolean,
    val freeReason: String?,
)

/** One priced day of the stay. */
data class PricedDayRow(
    val dayIndex: Int,
    val items: List<PricedItem>,
    val customized: Boolean,
    val canOvernight: Boolean,
    val isOvernight: Boolean,
    val overnightCost: Double,
    val overnightLabel: String,
    val overnightStartMin: Int?,
    val coverage: Coverage,
    val dayCost: Double,
)

/** A fully priced package across the stay. */
data class PricedPackage(
    val rows: List<PricedDayRow>,
    val subtotal: Double,
    val discountPct: Double,
    val discount: Double,
    val total: Double,
)

/** Context needed to price a package. */
data class PriceContext(
    val days: Int,
    val nights: Int,
    val durations: List<Duration>,
    val overnightDuration: Duration?,
)

/** Everything the quote text needs. */
data class QuoteInput(
    val clientName: String,
    val startDate: String,
    val days: Int,
    val pkg: Package,
    val priced: PricedPackage,
)

// ── defaults ────────────────────────────────────────────────────────────────

/** The shipped default menu. Only the 12hr is a true overnight; the 2hr and 6hr
 *  are long daytime stays (they can fill gaps). */
val DEFAULT_DURATIONS: List<Duration> = listOf(
    Duration("d1", "15-min visit", 15.0, 15.0, "visit"),
    Duration("d2", "30-min visit", 30.0, 25.0, "visit"),
    Duration("d3", "45-min visit", 45.0, 35.0, "visit"),
    Duration("d4", "60-min visit", 60.0, 45.0, "visit"),
    Duration("d5", "90-min visit", 90.0, 60.0, "visit"),
    Duration("d6", "2-hour visit", 120.0, 80.0, "visit"),
    Duration("d8", "6-hour visit", 360.0, 100.0, "visit"),
    Duration("d7", "Overnight (12hr)", 720.0, 150.0, "overnight"),
)

/** d7 was the only real overnight ever shipped before `kind` existed. */
private val LEGACY_OVERNIGHT_IDS = setOf("d7")

/** Migrate a menu saved before `kind` existed: blank kind → visit, except legacy d7. */
fun withKind(list: List<Duration>): List<Duration> = list.map { d ->
    if (d.kind == "visit" || d.kind == "overnight") d
    else d.copy(kind = if (LEGACY_OVERNIGHT_IDS.contains(d.id)) "overnight" else "visit")
}

/**
 * True when a KinCare type's NAME says it is an overnight.
 *
 * `serviceRates` carries a name, a length and a price and nothing else: there is
 * no `kind` column for the operator to set, so the name is the only signal there
 * is. Length is deliberately NOT a signal: a 6-hour day stay is a visit, a
 * 12-hour stay is not. Mirrors the web `isOvernightServiceName`.
 */
fun isOvernightServiceName(name: String): Boolean = name.lowercase().contains("overnight")

/**
 * The operator's KinCare types (`business_settings.serviceRates` plus
 * `serviceDurations`), read as the package builder's menu. Issue #693: the
 * builder's own "Visit menu" was a second rate card and is gone.
 *
 * The service NAME is the id, because that is the key `serviceRates` stores under
 * and the value every other reader sends. `serviceOptionsFromRates` (the same
 * helper Schedule and the booking wizard use) does the reading and the duration
 * precedence, so this is the one place a KinCare type becomes a [Duration].
 * Mirrors the web `durationsFromServiceRates` field for field.
 */
fun durationsFromServiceRates(
    rates: Map<String, String>,
    durations: Map<String, String> = emptyMap(),
): List<Duration> = serviceOptionsFromRates(rates, durations).map { option ->
    Duration(
        id = option.name,
        label = option.name,
        minutes = (option.durationMinutes ?: 0).toDouble(),
        price = option.rate.toDoubleOrNull() ?: 0.0,
        kind = if (isOvernightServiceName(option.name)) "overnight" else "visit",
    )
}

/**
 * Repoint any pinned visit whose length is not in the menu onto the first visit
 * type there (or onto nothing, when the menu holds no visit type).
 *
 * The menu used to be the builder's own list with its own synthetic ids
 * (`d1`…`d8`); it is now the KinCare types, keyed by name. The shipped default
 * pinned visit still carries one of the old ids, which would otherwise price at
 * $0 with no explanation. Mirrors the web `alignPinnedToDurations`.
 */
fun alignPinnedToDurations(rules: CoverageRules, durations: List<Duration>): CoverageRules {
    val fallback = durations.firstOrNull { it.kind == "visit" }?.id ?: ""
    val known = durations.map { it.id }.toSet()
    return rules.copy(
        pinnedTimes = rules.pinnedTimes.map { p -> if (known.contains(p.durationId)) p else p.copy(durationId = fallback) },
    )
}

/** Today as the "YYYY-MM-DD" string the date field carries, in the device's zone. */
fun todayIso(today: LocalDate = LocalDate.now()): String = today.toString()

val DEFAULT_COVERAGE_RULES = CoverageRules(
    wakeStart = "07:00",
    wakeEnd = "22:00",
    maxGapHours = 6.0,
    pinnedTimes = listOf(PinnedTime("seed-morning", "Morning feeding", "07:30", "d2")),
)

/** Fill a partial package up to a full one (used when seeding a new package). */
fun normalizePackage(
    id: String = uid(),
    name: String = "Package",
    visits: List<Visit> = emptyList(),
    note: String = "",
): Package = Package(id = id, name = name, visits = visits, note = note)

// ── small helpers ─────────────────────────────────────────────────────────────

fun uid(): String = UUID.randomUUID().toString().take(7)

/** Inclusive day count between two "YYYY-MM-DD" dates; 0 if unset or reversed. */
fun daysBetween(start: String, end: String): Int {
    if (start.isBlank() || end.isBlank()) return 0
    val s = runCatching { LocalDate.parse(start) }.getOrNull() ?: return 0
    val e = runCatching { LocalDate.parse(end) }.getOrNull() ?: return 0
    val diff = ChronoUnit.DAYS.between(s, e).toInt() + 1
    return if (diff > 0) diff else 0
}

/** A "YYYY-MM-DD" start date + a day offset → "Mon, Jul 28" (or "Jul 28" when monthDayOnly). */
fun dateLabel(startDate: String, offset: Int = 0, monthDayOnly: Boolean = false): String {
    if (startDate.isBlank()) return ""
    val base = runCatching { LocalDate.parse(startDate) }.getOrNull() ?: return ""
    val d = base.plusDays(offset.toLong())
    val month = d.month.getDisplayName(TextStyle.SHORT, Locale.US)
    if (monthDayOnly) return "$month ${d.dayOfMonth}"
    val weekday = d.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.US)
    return "$weekday, $month ${d.dayOfMonth}"
}

/** "HH:MM" -> minutes since midnight, or null when unparseable. */
fun timeToMinutes(t: String): Int? {
    if (t.isBlank()) return null
    val parts = t.split(":")
    val h = parts.getOrNull(0)?.toIntOrNull() ?: return null
    val m = parts.getOrNull(1)?.toIntOrNull() ?: return null
    return h * 60 + m
}

/** Minutes since midnight -> a 12h "h:MM AM/PM" label. */
fun minutesToTime(mins: Double): String {
    val norm = ((mins.roundToInt() % 1440) + 1440) % 1440
    val h = norm / 60
    val m = norm % 60
    val period = if (h >= 12) "PM" else "AM"
    val h12 = if (h % 12 == 0) 12 else h % 12
    return "$h12:${m.toString().padStart(2, '0')} $period"
}

/** Minutes since midnight -> "HH:MM" for a time input/picker. */
fun minutesToInput(mins: Int): String {
    val v = ((mins % 1440) + 1440) % 1440
    return "${(v / 60).toString().padStart(2, '0')}:${(v % 60).toString().padStart(2, '0')}"
}

/** A gap in minutes -> "1h 30m" / "45m" / "2h". */
fun formatGap(mins: Int): String {
    val h = mins / 60
    val m = mins % 60
    if (h == 0) return "${m}m"
    return if (m != 0) "${h}h ${m}m" else "${h}h"
}

// ── suggestions ───────────────────────────────────────────────────────────────

private val FILL_STRATEGIES = listOf("cheapest", "mid", "richest")

private fun <T> pick(pool: List<T>, strategy: String): T? {
    if (pool.isEmpty()) return null
    return when (strategy) {
        "cheapest" -> pool.first()
        "richest" -> pool.last()
        else -> pool[(pool.size - 1) / 2]
    }
}

/**
 * The operator's names for the three tiers (issue #694). The STRATEGY KEYS
 * ("cheapest" / "mid" / "richest") are what a pattern's `id` carries and are never
 * renamed; these are only their labels. The mid tier used to read "Balanced" and
 * the richest one "Generous".
 */
private fun strategyLabel(strategy: String): String = when (strategy) {
    "cheapest" -> "Lean"
    "richest" -> "Premium"
    else -> "Balance"
}

/** The wake window every tier falls back to when the client's own is unusable. */
private const val FALLBACK_WAKE_START = 7 * 60
private const val FALLBACK_WAKE_END = 22 * 60

/**
 * Build the three tiers, Lean / Balance / Premium: fill any gap wider than the
 * client's max-gap rule with one repeated duration, at three price points. Only a
 * SEED: every visit produced is editable afterwards.
 *
 * ALWAYS THREE, WHENEVER THERE IS A PRICED VISIT TO SELL (issue #694). This used
 * to drop a tier two ways, and the operator's own menu hit both: a wake window no
 * wider than the max gap with no pinned visit produced no touchpoints at all, and
 * near-identical tiers deduped into one. So the Packages screen offered nothing
 * but "New package". Now a tier that cannot satisfy the rules DEGRADES to the
 * closest thing it can build (one check-in in the middle of the day, in a length
 * that fits the window) and says so in `note`, and nothing is deduped. The one
 * precondition left is a priced visit duration. Mirrors the web buildDayPatterns.
 */
fun buildDayPatterns(
    durations: List<Duration>,
    pinnedTimes: List<PinnedTime>,
    maxGapHours: Double,
    wakeStart: String,
    wakeEnd: String,
): List<DayPattern> {
    val maxGapMin = maxGapHours * 60.0
    val rawStart = timeToMinutes(wakeStart)
    val rawEnd = timeToMinutes(wakeEnd)
    val windowUsable = rawStart != null && rawEnd != null && rawEnd > rawStart
    val wakeStartMin = if (windowUsable) rawStart!! else FALLBACK_WAKE_START
    val wakeEndMin = if (windowUsable) rawEnd!! else FALLBACK_WAKE_END
    // A window that does not end after it starts cannot be honoured, and refusing
    // to build was the same as showing the operator nothing. Build on the shipped
    // 7:00 AM to 10:00 PM day and say which day was used.
    val windowNote =
        if (windowUsable) ""
        else "Day window is not set (the end is not after the start), so this uses 7:00 AM to 10:00 PM."

    data class PinnedResolved(val pin: PinnedTime, val minutes: Int)
    val pinned = pinnedTimes
        .mapNotNull { p -> timeToMinutes(p.time)?.let { PinnedResolved(p, it) } }
        .sortedBy { it.minutes }

    val eligible = durations.filter { it.price > 0 && it.kind == "visit" }
    if (eligible.isEmpty()) return emptyList()

    val anchors = (listOf(wakeStartMin) + pinned.map { it.minutes } + listOf(wakeEndMin)).sorted()

    data class Gap(val start: Double, val size: Double)
    val gaps = mutableListOf<Gap>()
    for (i in 0 until anchors.size - 1) {
        val size = (anchors[i + 1] - anchors[i]).toDouble()
        if (size > maxGapMin) gaps.add(Gap(anchors[i].toDouble(), size))
    }

    val sortedByPrice = eligible.sortedBy { it.price }
    val patterns = mutableListOf<DayPattern>()

    for (strategy in FILL_STRATEGIES) {
        val fallback = pick(sortedByPrice, strategy) ?: continue

        val touchpoints = mutableListOf<Touchpoint>()
        for (pr in pinned) {
            val pd = durations.firstOrNull { it.id == pr.pin.durationId }
            touchpoints.add(
                Touchpoint(
                    isPinned = true,
                    label = pr.pin.label.ifBlank { "Pinned visit" },
                    time = pr.minutes.toDouble(),
                    durationId = pr.pin.durationId.ifBlank { fallback.id },
                    durationLabel = pd?.label ?: fallback.label,
                    price = pd?.price ?: fallback.price,
                ),
            )
        }

        for (gap in gaps) {
            val numFillVisits = ceil(gap.size / maxGapMin).toInt() - 1
            if (numFillVisits <= 0) continue
            val spacing = gap.size / (numFillVisits + 1)
            val fits = sortedByPrice.filter { it.minutes <= spacing }
            val fill = pick(if (fits.isNotEmpty()) fits else listOf(sortedByPrice.first()), strategy)!!
            for (i in 1..numFillVisits) {
                touchpoints.add(
                    Touchpoint(
                        isPinned = false,
                        label = "Check-in",
                        time = gap.start + (gap.size * i) / (numFillVisits + 1),
                        durationId = fill.id,
                        durationLabel = fill.label,
                        price = fill.price,
                    ),
                )
            }
        }

        // The rules asked for nobody on site: the day is no wider than the max gap
        // and the client pinned no visit. Returning nothing here is what left the
        // Packages screen with no tiers at all. Degrade instead: one check-in in
        // the middle of the day, in the longest length this strategy would pick
        // that still fits inside the window, and say so on the card.
        var note = windowNote
        if (touchpoints.isEmpty()) {
            val windowSize = (wakeEndMin - wakeStartMin).toDouble()
            val fitsWindow = sortedByPrice.filter { it.minutes <= windowSize }
            val only = pick(if (fitsWindow.isNotEmpty()) fitsWindow else listOf(sortedByPrice.first()), strategy)!!
            val at = ((wakeStartMin + wakeEndMin) / 2.0).roundToInt().toDouble()
            touchpoints.add(Touchpoint(false, "Check-in", at, only.id, only.label, only.price))
            val gapNote = "The ${formatGap(windowSize.roundToInt())} day fits inside the ${numLabel(maxGapHours)}h max gap, " +
                "so this tier is one check-in at ${minutesToTime(at)}."
            note = if (note.isEmpty()) gapNote else "$note $gapNote"
        }
        touchpoints.sortBy { it.time }

        val dayTotal = touchpoints.sumOf { it.price }
        val signature = touchpoints.joinToString("|") { "${it.durationId}@${it.time.roundToInt()}" }
        // Deliberately NOT deduped: two tiers that price the same are still two
        // cards the operator renames and edits apart, and collapsing them is half
        // of why the three tiers stopped appearing.
        patterns.add(DayPattern(strategy, strategyLabel(strategy), touchpoints.toList(), dayTotal, signature, note))
    }

    return patterns.sortedBy { it.dayTotal }
}

/** "6" for 6.0, "5.5" for 5.5: the max gap as the operator typed it. */
private fun numLabel(v: Double): String = if (v == floor(v)) v.toLong().toString() else v.toString()

/**
 * The three tiers as ready-to-edit packages, which is how the operator asked for
 * them: auto-created for every quote alongside the custom package, not as seed
 * buttons they have to find and press (issue #694).
 */
fun packagesFromPatterns(patterns: List<DayPattern>): List<Package> =
    patterns.map { p -> normalizePackage(id = uid(), name = p.strategyLabel, visits = visitsFromPattern(p), note = p.note) }

/** Seed a package's visit template from a suggestion. */
fun visitsFromPattern(pattern: DayPattern): List<Visit> =
    pattern.touchpoints.map { Visit(uid(), it.time.roundToInt(), it.durationId, it.label) }

/** Seed a blank package from the client's pinned visits. */
fun visitsFromPinned(pinnedTimes: List<PinnedTime>): List<Visit> =
    pinnedTimes
        .mapNotNull { p -> timeToMinutes(p.time)?.let { p to it } }
        .sortedBy { it.second }
        .map { (p, min) -> Visit(uid(), min, p.durationId, p.label) }

// ── pricing ───────────────────────────────────────────────────────────────────

/** The visits scheduled on a given day: its override if it has one, else the template. */
fun effectiveVisits(pkg: Package, dayIndex: Int): List<Visit> = pkg.dayOverrides[dayIndex] ?: pkg.visits

/** What an overnight covers on `dayIndex`. */
fun coverageForDay(pkg: Package, dayIndex: Int, nights: Int, overnightDuration: Duration?): Coverage {
    val startMin = timeToMinutes(pkg.overnightStart)
    if (startMin == null || overnightDuration == null) return BARE_COVERAGE

    val span = overnightDuration.minutes
    val bufferMin = (max(0.0, pkg.overnightBufferHours) * 60).roundToInt()
    val tonight = dayIndex < nights && pkg.overnightNights[dayIndex] == true
    val priorNight = dayIndex > 0 && pkg.overnightNights[dayIndex - 1] == true
    val endAbs = startMin + span

    return Coverage(
        eveningFrom = if (tonight) startMin - bufferMin else null,
        morningUntil = if (priorNight && endAbs > 1440) (endAbs - 1440).roundToInt() else null,
        bonusFreeVisit = priorNight,
    )
}

/** Price a single day's visits against its overnight coverage. */
fun priceDay(visits: List<Visit>, durations: List<Duration>, coverage: Coverage): Pair<List<PricedItem>, Double> {
    val sorted = visits.sortedBy { it.time }
    val items = sorted.map { v ->
        val d = durations.firstOrNull { it.id == v.durationId }
        val price = d?.price ?: 0.0
        val coveredMorning = coverage.morningUntil != null && v.time <= coverage.morningUntil
        val coveredEvening = coverage.eveningFrom != null && v.time >= coverage.eveningFrom
        val covered = coveredMorning || coveredEvening
        PricedItem(
            key = v.id,
            time = v.time,
            label = v.label.ifBlank { "Visit" },
            durationLabel = d?.label ?: "no duration set",
            price = if (covered) 0.0 else price,
            listPrice = price,
            covered = covered,
            bonus = false,
            free = covered,
            freeReason = if (covered) "covered by overnight" else null,
        )
    }.toMutableList()

    if (coverage.bonusFreeVisit) {
        val idx = items.indexOfFirst { !it.free }
        if (idx >= 0) {
            items[idx] = items[idx].copy(price = 0.0, bonus = true, free = true, freeReason = "free visit — overnight bundle")
        }
    }

    return items.toList() to items.sumOf { it.price }
}

/** Gaps checked against the rule but never blocking — a hand-built day is the sitter's call. */
fun gapWarnings(visits: List<Visit>, wakeStart: String, wakeEnd: String, maxGapHours: Double, coverage: Coverage): List<String> {
    val ws = timeToMinutes(wakeStart)
    val we = timeToMinutes(wakeEnd)
    if (ws == null || we == null || we <= ws) return emptyList()

    val from = if (coverage.morningUntil != null) max(ws, coverage.morningUntil) else ws
    val to = if (coverage.eveningFrom != null) min(we, coverage.eveningFrom) else we
    if (to <= from) return emptyList()

    val maxGap = maxGapHours * 60
    val inside = visits.map { it.time }.filter { it > from && it < to }.sorted()
    val anchors = listOf(from) + inside + listOf(to)
    val out = mutableListOf<String>()
    for (i in 0 until anchors.size - 1) {
        val size = anchors[i + 1] - anchors[i]
        if (size > maxGap) out.add("${minutesToTime(anchors[i].toDouble())} → ${minutesToTime(anchors[i + 1].toDouble())} is ${formatGap(size)}")
    }
    return out
}

/** Price a whole package across the stay. */
fun pricePackage(pkg: Package, ctx: PriceContext): PricedPackage {
    val rows = mutableListOf<PricedDayRow>()
    for (i in 0 until ctx.days) {
        val coverage = coverageForDay(pkg, i, ctx.nights, ctx.overnightDuration)
        val (items, dayTotal) = priceDay(effectiveVisits(pkg, i), ctx.durations, coverage)
        val canOvernight = i < ctx.nights
        val isOvernight = canOvernight && pkg.overnightNights[i] == true
        val overnightCost = if (isOvernight && ctx.overnightDuration != null) ctx.overnightDuration.price else 0.0
        rows.add(
            PricedDayRow(
                dayIndex = i,
                items = items,
                customized = pkg.dayOverrides.containsKey(i),
                canOvernight = canOvernight,
                isOvernight = isOvernight,
                overnightCost = overnightCost,
                overnightLabel = ctx.overnightDuration?.label ?: "",
                overnightStartMin = timeToMinutes(pkg.overnightStart),
                coverage = coverage,
                dayCost = dayTotal + overnightCost,
            ),
        )
    }
    val subtotal = rows.sumOf { it.dayCost }
    val pct = min(100.0, max(0.0, pkg.discountPct))
    val discount = subtotal * (pct / 100)
    return PricedPackage(rows, subtotal, pct, discount, subtotal - discount)
}

// ── quote text ────────────────────────────────────────────────────────────────

/** A clean plain-text quote for the clipboard / share sheet. Byte-matched to web. */
fun quoteText(input: QuoteInput): String {
    fun money(n: Double): String = "$" + String.format(Locale.US, "%.2f", n)
    val pkg = input.pkg
    val days = input.days
    val lines = mutableListOf("TribeTails — Coverage Package", "")
    if (input.clientName.trim().isNotEmpty()) lines.add("Prepared for: ${input.clientName.trim()}")
    lines.add("${pkg.name} · $days day${if (days != 1) "s" else ""}")
    if (input.startDate.isNotBlank()) lines.add("${dateLabel(input.startDate, 0)} – ${dateLabel(input.startDate, days - 1)}")
    lines.add("")

    for (r in input.priced.rows) {
        val whenLabel = if (input.startDate.isNotBlank()) dateLabel(input.startDate, r.dayIndex) else "Day ${r.dayIndex + 1}"
        val on = if (r.isOvernight && r.overnightStartMin != null) "   (overnight from ${minutesToTime(r.overnightStartMin.toDouble())})" else ""
        lines.add("Day ${r.dayIndex + 1} — $whenLabel$on   ${money(r.dayCost)}")
        for (it in r.items) {
            val price = if (it.free) "free" else money(it.price)
            val reason = if (it.freeReason != null) " — ${it.freeReason}" else ""
            lines.add("   ${minutesToTime(it.time.toDouble()).padEnd(9)} ${it.label} (${it.durationLabel})$reason   $price")
        }
        if (r.isOvernight && r.overnightStartMin != null) {
            lines.add("   ${minutesToTime(r.overnightStartMin.toDouble()).padEnd(9)} ${r.overnightLabel}   ${money(r.overnightCost)}")
        }
        lines.add("")
    }

    lines.add("Subtotal   ${money(input.priced.subtotal)}")
    if (input.priced.discountPct > 0) lines.add("${pkg.discountLabel.ifBlank { "Discount" }} (${input.priced.discountPct.roundToInt()}%)   -${money(input.priced.discount)}")
    lines.add("Total   ${money(input.priced.total)}")
    return lines.joinToString("\n")
}
