package com.tribetails.auntieos.web.data

import com.tribetails.auntieos.web.observability.runCatchingCancellable
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * #1863 / #2034: WHAT A HOUSEHOLD IS SHOWN FOR A VISIT, mirrored from the server
 * rule (`mytribe/functions/src/lib/bookingTimeBlocks.ts`: `storedBookingMode`,
 * `resolveBookingPolicy`, `householdBlockFor`) and from the admin web copy
 * (`auntieos-admin/src/lib/householdVisitTime.ts`). The portal is told by the
 * server; the console's own cards use this copy so they name the same block.
 * Every copy runs the shared case table in
 * `mytribe/functions/test/fixtures/householdVisitTime.json`.
 *
 * Operator rulings: one Business Settings mode, Time Blocks or Exact times
 * (2026-11-12). In Time Blocks mode the household sees only blocks, and a clock
 * time the office booked in no block is shown as "The nearest block"
 * (2026-11-13). In Exact times mode it sees the clock.
 */
object HouseholdVisitTime {
    /** Wire values, as `defaultBookingMode` stores them. */
    const val TIME_BLOCK = "TIME_BLOCK"
    const val SPECIFIC_TIME = "SPECIFIC_TIME"

    /** The same sentence `saveBusinessSettings` refuses with. */
    const val TIME_BLOCKS_NEED_A_BLOCK =
        "Time Blocks needs at least one block turned on. Turn one on, or pick Exact times."

    /** One readable, active block, as the server's `parseTimeBlockRow` keeps it. */
    data class Block(
        val id: String,
        val label: String,
        val startTime: String,
        val endTime: String,
        val start: Int,
        val end: Int,
    )

    /**
     * The mode as STORED (server `storedBookingMode`): exactly one switch on is
     * that switch; both on (the stored default) or both off is the mode
     * `defaultBookingMode` names, which defaults to SPECIFIC_TIME.
     */
    fun storedMode(allowTimeBlockBooking: Boolean?, allowSpecificTimeBooking: Boolean?, defaultBookingMode: String?): String {
        val block = allowTimeBlockBooking ?: true
        val specific = allowSpecificTimeBooking ?: true
        if (block && !specific) return TIME_BLOCK
        if (!block && specific) return SPECIFIC_TIME
        return if (defaultBookingMode == TIME_BLOCK) TIME_BLOCK else SPECIFIC_TIME
    }

    fun storedMode(s: BusinessSettings): String =
        storedMode(s.allowTimeBlockBooking, s.allowSpecificTimeBooking, s.defaultBookingMode)

    /** The three fields a mode is written as. Every editor writes all three. */
    data class ModeFields(
        val defaultBookingMode: String,
        val allowTimeBlockBooking: Boolean,
        val allowSpecificTimeBooking: Boolean,
    )

    fun modeFields(mode: String): ModeFields =
        if (mode == TIME_BLOCK) ModeFields(TIME_BLOCK, allowTimeBlockBooking = true, allowSpecificTimeBooking = false)
        else ModeFields(SPECIFIC_TIME, allowTimeBlockBooking = false, allowSpecificTimeBooking = true)

    private fun minutesOf(raw: String, allowEndOfDay: Boolean): Int? {
        val m = Regex("""^(\d{1,2}):(\d{2})$""").matchEntire(raw.trim()) ?: return null
        val hh = m.groupValues[1].toIntOrNull() ?: return null
        val mm = m.groupValues[2].toIntOrNull() ?: return null
        if (mm !in 0..59 || hh < 0) return null
        val total = hh * 60 + mm
        val max = if (allowEndOfDay) 24 * 60 else 24 * 60 - 1
        return if (total > max) null else total
    }

    private fun hhmm(minutes: Int): String =
        "${(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}"

    private fun labelFromId(id: String): String =
        id.split(Regex("""[-_\s]+""")).filter { it.isNotEmpty() }
            .joinToString(" ") { w -> w.replaceFirstChar { it.uppercaseChar() } }

    /**
     * The active, readable blocks in start order, read the way the server reads
     * them: an inactive row, a row with no id or no readable start is dropped; a
     * row with no readable end runs for [defaultBlockHours] (4 when unset), never
     * past midnight.
     */
    fun usableBlocks(rows: List<TimeBlockDefinition>, defaultBlockHours: Int? = null): List<Block> {
        val hours = defaultBlockHours?.takeIf { it > 0 } ?: 4
        return rows.mapNotNull { row ->
            if (!row.isActive) return@mapNotNull null
            val id = row.id.trim()
            if (id.isEmpty()) return@mapNotNull null
            val start = minutesOf(row.startTime, allowEndOfDay = false) ?: return@mapNotNull null
            val parsedEnd = minutesOf(row.endTime, allowEndOfDay = true)
            val end = if (parsedEnd != null && parsedEnd > start) parsedEnd else minOf(24 * 60, start + maxOf(1, hours * 60))
            if (end <= start) return@mapNotNull null
            val label = row.label.trim().ifEmpty { labelFromId(id) }
            Block(id, label, hhmm(start), if (end == 24 * 60) "24:00" else hhmm(end), start, end)
        }.sortedWith(compareBy<Block> { it.start }.thenBy { it.id })
    }

    /** What the rule needs to know about the business. */
    data class Settings(
        val allowTimeBlockBooking: Boolean?,
        val allowSpecificTimeBooking: Boolean?,
        val defaultBookingMode: String?,
        val timeBlocks: List<TimeBlockDefinition>,
        val startTimeServiceIds: List<String> = emptyList(),
        val defaultBlockHours: Int? = null,
    )

    fun settingsOf(s: BusinessSettings): Settings = Settings(
        allowTimeBlockBooking = s.allowTimeBlockBooking,
        allowSpecificTimeBooking = s.allowSpecificTimeBooking,
        defaultBookingMode = s.defaultBookingMode,
        timeBlocks = s.timeBlocks,
        startTimeServiceIds = startTimeServiceIds(s.serviceStartTimeBooking),
        defaultBlockHours = s.defaultTimeBlockDurationHours,
    )

    /** The start-time KinCares off `serviceStartTimeBooking`, as the server reads them. */
    fun startTimeServiceIds(map: Map<String, Boolean>): List<String> =
        map.filter { (id, flag) -> flag && id.isNotBlank() }.keys.sorted()

    /**
     * The mode the household is SERVED (server `resolveBookingPolicy`): the stored
     * mode, except Time Blocks with no usable block, which is served as Exact times.
     */
    fun servedMode(s: Settings): String {
        val stored = storedMode(s.allowTimeBlockBooking, s.allowSpecificTimeBooking, s.defaultBookingMode)
        if (stored == TIME_BLOCK && usableBlocks(s.timeBlocks, s.defaultBlockHours).isEmpty()) return SPECIFIC_TIME
        return stored
    }

    /**
     * The block for a business-local minute of the day: the booked block when the
     * start is inside it, else the first block containing it, else the nearest by
     * distance to the closer edge; a TIE goes to the earlier block.
     */
    fun nearestBlockForMinutes(minutes: Int, storedBlockId: String, blocks: List<Block>): Block? {
        if (blocks.isEmpty()) return null
        fun inside(b: Block) = minutes >= b.start && minutes < b.end
        val booked = if (storedBlockId.isEmpty()) null else blocks.firstOrNull { it.id == storedBlockId }
        if (booked != null && inside(booked)) return booked
        blocks.firstOrNull(::inside)?.let { return it }
        var best = blocks.first()
        var bestDistance = Int.MAX_VALUE
        for (b in blocks) {
            val distance = if (minutes < b.start) b.start - minutes else minutes - b.end
            if (distance < bestDistance) {
                best = b
                bestDistance = distance
            }
        }
        return best
    }

    /**
     * The block a household sees for a visit at business-local [minutes], or null
     * when it sees the clock (Exact times mode, or a start-time KinCare).
     */
    fun householdBlockForMinutes(minutes: Int?, storedBlockId: String?, serviceId: String?, s: Settings): Block? {
        if (servedMode(s) != TIME_BLOCK) return null
        if (minutes == null) return null
        if (serviceId != null && serviceId in s.startTimeServiceIds) return null
        return nearestBlockForMinutes(minutes, storedBlockId?.trim().orEmpty(), usableBlocks(s.timeBlocks, s.defaultBlockHours))
    }

    /** The block a household sees for an instant, read on the BUSINESS clock. */
    @OptIn(ExperimentalTime::class)
    fun householdBlockFor(startMs: Long?, storedBlockId: String?, serviceId: String?, s: Settings, businessZone: TimeZone): Block? {
        if (startMs == null) return null
        val local = Instant.fromEpochMilliseconds(startMs).toLocalDateTime(businessZone)
        return householdBlockForMinutes(local.hour * 60 + local.minute, storedBlockId, serviceId, s)
    }

    /**
     * #2034: the block name a Bookings or Auntie Time card shows for a session:
     * the block the HOUSEHOLD sees for it, decided by the rule above on the
     * business clock, so a visit the office moved names where it now is. Null in
     * Exact times mode (the household sees the clock, so the card names no
     * block), for a start-time KinCare, and when the start cannot be read.
     * [serviceName] is the catalog name the card already resolved.
     */
    fun cardBlockLabel(startTime: String, serviceName: String?, settings: Settings, businessZone: TimeZone): String? =
        householdBlockForMinutes(businessMinutesOf(startTime, businessZone), null, serviceName, settings)?.label
    /**
     * A session's stored `startTime` as a business-local minute of the day. An
     * instant that carries its zone ("...Z", "...-05:00") is read on [businessZone];
     * a bare wall clock ("2026-11-17T12:30", "12:30") is the business's own clock
     * already, which is how the office writes it.
     */
    @OptIn(ExperimentalTime::class)
    fun businessMinutesOf(startTime: String, businessZone: TimeZone): Int? {
        val t = startTime.trim()
        if (t.isEmpty()) return null
        val zoned = runCatchingCancellable { Instant.parse(t) }.getOrNull()
        if (zoned != null) {
            val local = zoned.toLocalDateTime(businessZone)
            return local.hour * 60 + local.minute
        }
        return parseMinutesOfDay(t)
    }
}
