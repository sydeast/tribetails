package com.tribetails.auntieos.domain

import androidx.annotation.Keep
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * Coverage Package Builder — pure domain logic. Android port of the web
 * `lib/coveragePackage.ts`, kept behaviour-identical so a config saved on one
 * platform prices the same on the other.
 *
 * An operator prices a multi-day stay by describing ONE covered day: a wake
 * window, a max gap allowed between visits, and any pinned (fixed-time) visits.
 * [buildDayPatterns] turns those rules into a few rule-valid daily schedules at
 * Lean / Balanced / Generous price points; the screen prices the approved one
 * across the stay.
 *
 * The [Duration], [PinnedTime] and [CoverageRules] classes double as the
 * Firestore wire model (var + defaults + @Keep), read/written through
 * [com.tribetails.auntieos.data.model.CoveragePackageConfig]. [Touchpoint] and
 * [DayPattern] are derived, never persisted.
 */

/** A named visit length with its price. */
@Keep
data class Duration(
    var id: String = "",
    var label: String = "",
    var minutes: Double = 0.0,
    var price: Double = 0.0,
)

/** A visit that must happen at a fixed "HH:MM" time every covered day. */
@Keep
data class PinnedTime(
    var id: String = "",
    var label: String = "",
    var time: String = "",
    var durationId: String = "",
)

/** The per-client coverage rules that shape a valid day. */
@Keep
data class CoverageRules(
    var wakeStart: String = "07:00",
    var wakeEnd: String = "22:00",
    var maxGapHours: Double = 6.0,
    var pinnedTimes: List<PinnedTime> = emptyList(),
)

/** One visit inside a generated day: a pinned time or a gap-filling check-in. */
data class Touchpoint(
    val isPinned: Boolean,
    val label: String,
    /** Minutes since midnight. */
    val time: Double,
    val durationId: String,
    val durationLabel: String,
    val price: Double,
)

/** A complete, rule-valid schedule for one covered day. */
data class DayPattern(
    val id: String,
    val strategyLabel: String,
    val touchpoints: List<Touchpoint>,
    val overnightCost: Double,
    val overnightLabel: String?,
    val dayTotal: Double,
)

/** Visit-length ceiling (minutes) separating flexible day visits from overnights. */
const val OVERNIGHT_MINUTES = 300.0

/** The shipped default visit menu, used until an operator edits it. */
val DEFAULT_DURATIONS: List<Duration> = listOf(
    Duration("d1", "15-min visit", 15.0, 15.0),
    Duration("d2", "30-min visit", 30.0, 22.0),
    Duration("d3", "45-min visit", 45.0, 28.0),
    Duration("d4", "60-min visit", 60.0, 35.0),
    Duration("d5", "90-min visit", 90.0, 60.0),
    Duration("d6", "Overnight (2hr)", 120.0, 80.0),
    Duration("d7", "Overnight (12hr)", 720.0, 150.0),
)

/** The shipped default coverage rules. Pinned id is fixed (not random) so the
 *  default is stable across reads and safe to compare in tests. */
val DEFAULT_COVERAGE_RULES = CoverageRules(
    wakeStart = "07:00",
    wakeEnd = "22:00",
    maxGapHours = 6.0,
    pinnedTimes = listOf(PinnedTime("seed-morning", "Morning feeding", "07:30", "d2")),
)

/** Inclusive day count between two "YYYY-MM-DD" dates; 0 if unset or reversed. */
fun daysBetween(start: String, end: String): Int {
    if (start.isBlank() || end.isBlank()) return 0
    val s = runCatching { LocalDate.parse(start) }.getOrNull() ?: return 0
    val e = runCatching { LocalDate.parse(end) }.getOrNull() ?: return 0
    val diff = ChronoUnit.DAYS.between(s, e).toInt() + 1
    return if (diff > 0) diff else 0
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
    val whole = mins.roundToInt()
    val h = floor(((((whole % 1440) + 1440) % 1440) / 60.0)).toInt()
    val m = (((whole % 60) + 60) % 60)
    val period = if (h >= 12) "PM" else "AM"
    val h12 = if (h % 12 == 0) 12 else h % 12
    return "$h12:${m.toString().padStart(2, '0')} $period"
}

private val FILL_STRATEGIES = listOf("cheapest", "mid", "richest")

private fun strategyLabel(strategy: String): String = when (strategy) {
    "cheapest" -> "Lean"
    "richest" -> "Generous"
    else -> "Balanced"
}

/**
 * Turn coverage rules into a few rule-valid daily schedules at distinct prices.
 * Three fill strategies (Lean / Balanced / Generous) vary which duration fills
 * the gaps; literal duplicates are collapsed by structural signature, and the
 * result is ordered cheapest-first. Returns empty for an invalid day window.
 */
fun buildDayPatterns(
    durations: List<Duration>,
    rules: CoverageRules,
    useOvernight: Boolean,
    overnightDurationId: String,
): List<DayPattern> {
    val maxGapMin = rules.maxGapHours * 60.0
    val wakeStartMin = timeToMinutes(rules.wakeStart)
    val wakeEndMin = timeToMinutes(rules.wakeEnd)
    if (wakeStartMin == null || wakeEndMin == null || wakeEndMin <= wakeStartMin) return emptyList()

    data class PinnedResolved(val pin: PinnedTime, val minutes: Int)
    val pinned = rules.pinnedTimes
        .mapNotNull { p -> timeToMinutes(p.time)?.let { PinnedResolved(p, it) } }
        .sortedBy { it.minutes }

    // Exclude overnight-length visits from the flexible day fill.
    val eligibleDurations = durations.filter { it.price > 0 && it.minutes < OVERNIGHT_MINUTES }
    if (eligibleDurations.isEmpty() && pinned.isEmpty()) return emptyList()

    // Fixed anchors across the wake window: start, each pinned time, end.
    val anchors = (listOf(wakeStartMin) + pinned.map { it.minutes } + listOf(wakeEndMin)).sorted()

    data class Gap(val start: Double, val size: Double)
    val gaps = mutableListOf<Gap>()
    for (i in 0 until anchors.size - 1) {
        val from = anchors[i]
        val to = anchors[i + 1]
        val gapSize = (to - from).toDouble()
        if (gapSize > maxGapMin) gaps.add(Gap(from.toDouble(), gapSize))
    }

    val sortedByPrice = eligibleDurations.sortedBy { it.price }
    val patterns = mutableListOf<Pair<DayPattern, String>>() // pattern + signature

    for (strategy in FILL_STRATEGIES) {
        val fill: Duration? = when (strategy) {
            "cheapest" -> sortedByPrice.firstOrNull()
            "richest" -> sortedByPrice.lastOrNull()
            else -> sortedByPrice.getOrNull((sortedByPrice.size - 1) / 2)
        }
        if (fill == null) continue

        val touchpoints = mutableListOf<Touchpoint>()
        for (pr in pinned) {
            val pinnedDuration = durations.firstOrNull { it.id == pr.pin.durationId }
            touchpoints.add(
                Touchpoint(
                    isPinned = true,
                    label = pr.pin.label.ifBlank { "Pinned visit" },
                    time = pr.minutes.toDouble(),
                    durationId = pr.pin.durationId.ifBlank { fill.id },
                    durationLabel = pinnedDuration?.label ?: fill.label,
                    price = pinnedDuration?.price ?: fill.price,
                ),
            )
        }

        for (gap in gaps) {
            val numFillVisits = ceil(gap.size / maxGapMin).toInt() - 1
            if (numFillVisits <= 0) continue
            for (i in 1..numFillVisits) {
                val t = gap.start + (gap.size * i) / (numFillVisits + 1)
                touchpoints.add(
                    Touchpoint(
                        isPinned = false,
                        label = "Check-in",
                        time = t,
                        durationId = fill.id,
                        durationLabel = fill.label,
                        price = fill.price,
                    ),
                )
            }
        }

        touchpoints.sortBy { it.time }

        var overnightCost = 0.0
        var overnightLabel: String? = null
        if (useOvernight) {
            val od = durations.firstOrNull { it.id == overnightDurationId }
            if (od != null) {
                overnightCost = od.price
                overnightLabel = od.label
            }
        }

        val dayTotal = touchpoints.sumOf { it.price } + overnightCost
        val signature = touchpoints.joinToString("|") { "${it.durationId}@${it.time.roundToInt()}" } +
            (if (useOvernight) "+ON:$overnightDurationId" else "")

        if (patterns.any { it.second == signature }) continue

        patterns.add(
            DayPattern(
                id = signature.ifBlank { "empty" },
                strategyLabel = strategyLabel(strategy),
                touchpoints = touchpoints.toList(),
                overnightCost = overnightCost,
                overnightLabel = overnightLabel,
                dayTotal = dayTotal,
            ) to signature,
        )
    }

    return patterns.map { it.first }.sortedBy { it.dayTotal }
}
