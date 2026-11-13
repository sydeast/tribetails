package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.BookingMode
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.TimeBlockDefinition
import com.tribetails.auntieos.data.model.businessZone
import com.tribetails.auntieos.data.model.withBookingMode
import java.time.Instant
import java.time.ZoneId

/**
 * #1863 / #2034: WHAT A HOUSEHOLD IS SHOWN FOR A VISIT, mirrored from the
 * server rule (`mytribe/functions/src/lib/bookingTimeBlocks.ts`:
 * `storedBookingMode`, `resolveBookingPolicy`, `householdBlockFor`) and from
 * the admin web copy (`auntieos-admin/src/lib/householdVisitTime.ts`). The
 * portal is told by the server; the office's own cards use this copy so they
 * name the same block. All three run the shared case table
 * `mytribe/functions/test/fixtures/householdVisitTime.json`.
 *
 * Operator rulings: one Business Settings mode, Time Blocks or Exact times
 * (2026-11-12). In Time Blocks mode the household sees only blocks, and a
 * clock time the office booked in no block is shown as "The nearest block"
 * (2026-11-13). In Exact times mode it sees the clock.
 */

/** The one mode. Wire values, as `defaultBookingMode` stores them. */
const val TIME_BLOCK_MODE = "TIME_BLOCK"
const val EXACT_TIMES_MODE = "SPECIFIC_TIME"

/** The same sentence `saveBusinessSettings` refuses with. */
const val TIME_BLOCKS_NEED_A_BLOCK =
    "Time Blocks needs at least one block turned on. Turn one on, or pick Exact times."

/**
 * The mode as STORED (server `storedBookingMode`): exactly one switch on is
 * that switch; both on (the stored default) or both off is the mode
 * `defaultBookingMode` names, which defaults to SPECIFIC_TIME.
 */
fun storedHouseholdTimeMode(allowTimeBlockBooking: Boolean, allowSpecificTimeBooking: Boolean, defaultBookingMode: String): String = when {
    allowTimeBlockBooking && !allowSpecificTimeBooking -> TIME_BLOCK_MODE
    !allowTimeBlockBooking && allowSpecificTimeBooking -> EXACT_TIMES_MODE
    defaultBookingMode == TIME_BLOCK_MODE -> TIME_BLOCK_MODE
    else -> EXACT_TIMES_MODE
}

fun storedHouseholdTimeMode(s: BusinessSettings): String =
    storedHouseholdTimeMode(s.allowTimeBlockBooking, s.allowSpecificTimeBooking, s.defaultBookingMode)

/**
 * [this] with the one mode written as all three of its stored fields, the
 * only shape `saveBusinessSettings` accepts ("Pick Time Blocks or Exact times.").
 */
fun BusinessSettings.withHouseholdTimeMode(mode: String): BusinessSettings =
    withBookingMode(if (mode == TIME_BLOCK_MODE) BookingMode.TIME_BLOCK else BookingMode.SPECIFIC_TIME)

/** One readable, active block: what the server's `parseTimeBlockRow` keeps. */
data class HouseholdBlock(
    val id: String,
    val label: String,
    val startTime: String,
    val endTime: String,
    val start: Int,
    val end: Int,
)

private const val END_OF_DAY = 24 * 60

/** "09:30" to 570; "24:00" only when [allowEndOfDay]. Null on anything that is not a real HH:mm. */
private fun hhmmMinutes(raw: String, allowEndOfDay: Boolean = false): Int? {
    val m = Regex("""^(\d{1,2}):(\d{2})$""").matchEntire(raw.trim()) ?: return null
    val hh = m.groupValues[1].toInt()
    val mm = m.groupValues[2].toInt()
    if (allowEndOfDay && hh == 24 && mm == 0) return END_OF_DAY
    if (hh > 23 || mm > 59) return null
    return hh * 60 + mm
}

private fun hhmm(minutes: Int): String =
    if (minutes == END_OF_DAY) "24:00" else "%02d:%02d".format(minutes / 60, minutes % 60)

/** 'midday' -> 'Midday', 'late-afternoon' -> 'Late Afternoon', as the server names an unlabelled row. */
private fun labelFromId(id: String): String =
    id.split(Regex("""[-_\s]+""")).filter { it.isNotEmpty() }
        .joinToString(" ") { it.replaceFirstChar { c -> c.uppercaseChar() } }

/**
 * The active, readable blocks in start order, read the way the server reads
 * them: an inactive row, a row with no id or no readable start is dropped; a
 * row with no readable end runs for [defaultTimeBlockDurationHours] (4 when
 * unset), never past midnight.
 */
fun usableBlocks(rows: List<TimeBlockDefinition>, defaultTimeBlockDurationHours: Int = 4): List<HouseholdBlock> {
    val hours = if (defaultTimeBlockDurationHours > 0) defaultTimeBlockDurationHours else 4
    return rows.mapNotNull { row ->
        if (!row.isActive) return@mapNotNull null
        val id = row.id.trim()
        if (id.isEmpty()) return@mapNotNull null
        val start = hhmmMinutes(row.startTime) ?: return@mapNotNull null
        val parsedEnd = hhmmMinutes(row.endTime, allowEndOfDay = true)
        val end = if (parsedEnd != null && parsedEnd > start) parsedEnd else minOf(END_OF_DAY, start + hours * 60)
        if (end <= start) return@mapNotNull null
        val label = row.label.trim().ifEmpty { labelFromId(id) }
        HouseholdBlock(id, label, hhmm(start), hhmm(end), start, end)
    }.sortedWith(compareBy<HouseholdBlock> { it.start }.thenBy { it.id })
}

/** What the household-time rule needs to know about the business. */
data class HouseholdTimeSettings(
    val allowTimeBlockBooking: Boolean,
    val allowSpecificTimeBooking: Boolean,
    val defaultBookingMode: String,
    val timeBlocks: List<TimeBlockDefinition>,
    val startTimeServiceIds: List<String>,
    val defaultTimeBlockDurationHours: Int = 4,
    /** `business_settings.timeZone` as stored; read through [businessZone]. */
    val timeZone: String = "",
)

/** The settings the rule reads, off the owner's document. */
fun BusinessSettings.householdTimeSettings(): HouseholdTimeSettings = HouseholdTimeSettings(
    allowTimeBlockBooking = allowTimeBlockBooking,
    allowSpecificTimeBooking = allowSpecificTimeBooking,
    defaultBookingMode = defaultBookingMode,
    timeBlocks = timeBlocks,
    startTimeServiceIds = startTimeServiceIdsFrom(serviceStartTimeBooking),
    defaultTimeBlockDurationHours = defaultTimeBlockDurationHours,
    timeZone = timeZone,
)

/**
 * The mode the household is SERVED (server `resolveBookingPolicy`): the stored
 * mode, except Time Blocks with no usable block, which is served as Exact
 * times because there is nothing to show.
 */
fun servedHouseholdTimeMode(s: HouseholdTimeSettings): String {
    val stored = storedHouseholdTimeMode(s.allowTimeBlockBooking, s.allowSpecificTimeBooking, s.defaultBookingMode)
    if (stored == TIME_BLOCK_MODE && usableBlocks(s.timeBlocks, s.defaultTimeBlockDurationHours).isEmpty()) {
        return EXACT_TIMES_MODE
    }
    return stored
}

/**
 * The block for a business-local minute of the day (server
 * `nearestBlockForMinutes`): the booked block when the start is inside it,
 * else the first block containing it, else the nearest by distance to the
 * closer edge; a TIE goes to the earlier block.
 */
fun nearestBlockForMinutes(minutes: Int, storedBlockId: String, blocks: List<HouseholdBlock>): HouseholdBlock? {
    if (blocks.isEmpty()) return null
    fun inside(b: HouseholdBlock) = minutes >= b.start && minutes < b.end
    val booked = if (storedBlockId.isEmpty()) null else blocks.firstOrNull { it.id == storedBlockId }
    if (booked != null && inside(booked)) return booked
    blocks.firstOrNull(::inside)?.let { return it }
    var best = blocks.first()
    var bestDistance = Int.MAX_VALUE
    for (b in blocks) {
        val distance = if (minutes < b.start) b.start - minutes else minutes - b.end
        // Strictly closer only: on a tie the earlier block, already in hand, stays.
        if (distance < bestDistance) {
            best = b
            bestDistance = distance
        }
    }
    return best
}

/**
 * The block a household sees for a visit starting at [startMs], or null when it
 * sees the clock (Exact times mode, no start, or a start-time KinCare). Read on
 * the BUSINESS clock ([zone]), never the device's.
 */
fun householdBlockFor(
    startMs: Long?,
    timeBlockId: String?,
    serviceId: String?,
    settings: HouseholdTimeSettings,
    zone: ZoneId = businessZone(settings.timeZone),
): HouseholdBlock? {
    if (servedHouseholdTimeMode(settings) != TIME_BLOCK_MODE) return null
    if (startMs == null) return null
    if (!serviceId.isNullOrBlank() && serviceId in settings.startTimeServiceIds) return null
    val local = Instant.ofEpochMilli(startMs).atZone(zone).toLocalTime()
    return nearestBlockForMinutes(
        local.hour * 60 + local.minute,
        timeBlockId?.trim().orEmpty(),
        usableBlocks(settings.timeBlocks, settings.defaultTimeBlockDurationHours),
    )
}

/**
 * [householdBlockFor] for a stored visit start string. An ISO instant
 * ("...Z" or with an offset) is read as that instant; a bare wall clock
 * ("2026-07-16T09:00:00") is already the business's own clock, so it is read
 * in [zone]. Null when the string carries no readable time.
 */
fun householdBlockForStartString(
    startTime: String,
    timeBlockId: String?,
    serviceId: String?,
    settings: HouseholdTimeSettings,
    zone: ZoneId = businessZone(settings.timeZone),
): HouseholdBlock? {
    val ms = visitStartMillis(startTime, zone)
    if (ms != null) return householdBlockFor(ms, timeBlockId, serviceId, settings, zone)
    // A bare "HH:mm" with no date is already the business's wall clock.
    if (servedHouseholdTimeMode(settings) != TIME_BLOCK_MODE) return null
    if (!serviceId.isNullOrBlank() && serviceId in settings.startTimeServiceIds) return null
    val minutes = hhmmMinutes(startTime) ?: return null
    return nearestBlockForMinutes(
        minutes,
        timeBlockId?.trim().orEmpty(),
        usableBlocks(settings.timeBlocks, settings.defaultTimeBlockDurationHours),
    )
}
/**
 * #1863 / #2034: the block name an office card shows beside a visit, the block
 * the HOUSEHOLD sees for it. Null in Exact times mode (the household sees the
 * clock), for a start-time KinCare, and before the settings read lands.
 */
fun householdBlockLabel(
    startTime: String,
    timeBlockId: String?,
    serviceId: String?,
    settings: HouseholdTimeSettings?,
    zone: ZoneId? = null,
): String? = settings?.let {
    householdBlockForStartString(startTime, timeBlockId, serviceId, it, zone ?: businessZone(it.timeZone))?.label
}

/** A stored visit start string to epoch millis, reading a bare wall clock in [zone]. */
fun visitStartMillis(raw: String, zone: ZoneId): Long? {
    val text = raw.trim()
    if (text.isEmpty()) return null
    runCatching { return Instant.parse(text).toEpochMilli() }
    runCatching { return java.time.OffsetDateTime.parse(text).toInstant().toEpochMilli() }
    runCatching { return java.time.LocalDateTime.parse(text).atZone(zone).toInstant().toEpochMilli() }
    return null
}

/** The start-time KinCares off `business_settings.serviceStartTimeBooking`, as the server reads them. */
fun startTimeServiceIdsFrom(map: Map<String, Boolean>): List<String> =
    map.filter { (id, flag) -> flag && id.isNotBlank() }.keys.sorted()

/** "Midday block", or the operator's own label when it already ends in "block". */
fun householdBlockWord(block: HouseholdBlock): String =
    if (Regex("""\bblock$""", RegexOption.IGNORE_CASE).containsMatchIn(block.label)) block.label else "${block.label} block"
