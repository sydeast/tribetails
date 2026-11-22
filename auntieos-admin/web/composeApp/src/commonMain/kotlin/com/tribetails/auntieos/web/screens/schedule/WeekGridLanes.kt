package com.tribetails.auntieos.web.screens.schedule

/**
 * #1861: where a visit block sits on the week grid, in minutes from the top of
 * the drawn window, and its lane among the blocks it overlaps. Pure, so the
 * geometry is unit-tested; the twins on admin web are `visitBlockPlacement`
 * and `gridLanes` in `lib/scheduleGrid.ts`.
 */

/** The legible minimum a block is drawn at, whatever the visit's length. */
internal const val MIN_BLOCK_MINUTES = 20

/** A block's drawn extent: [topMinute] from the window's top, [heightMinutes] tall. */
internal data class BlockSpan(val topMinute: Int, val heightMinutes: Int)

/**
 * The drawn extent of a visit starting at [startMinute] (minute of the day)
 * that runs [durationMinutes], or null when its start is outside [window].
 *
 * The height is at least [MIN_BLOCK_MINUTES] and never past the bottom edge. A
 * visit too close to the bottom for the minimum (23:46 on a grid that ends at
 * midnight) is LIFTED until it has it, ending on the bottom edge, rather than
 * drawn as a sliver with its time and household cut off. Its label still reads
 * its own start, and the drag maths uses that start, not this top.
 */
internal fun visitBlockSpan(startMinute: Int, durationMinutes: Int, window: WeekGridWindow): BlockSpan? {
    val windowStart = window.startHour * 60
    val windowEnd = window.endHour * 60
    if (startMinute < windowStart || startMinute >= windowEnd) return null
    val roomToBottom = windowEnd - startMinute
    val wanted = if (durationMinutes > 0) durationMinutes else MIN_BLOCK_MINUTES
    val height = maxOf(wanted, MIN_BLOCK_MINUTES).coerceAtMost(windowEnd - windowStart)
    return if (height <= roomToBottom) {
        BlockSpan(startMinute - windowStart, height)
    } else if (roomToBottom >= MIN_BLOCK_MINUTES) {
        // A long visit near the bottom: drawn to the edge, as before.
        BlockSpan(startMinute - windowStart, roomToBottom)
    } else {
        val shown = minOf(MIN_BLOCK_MINUTES, windowEnd - windowStart)
        BlockSpan(windowEnd - windowStart - shown, shown)
    }
}

/** A block's lane: [lane] from the left, of [lanes] in its group of overlaps. */
internal data class GridLane(val lane: Int, val lanes: Int)

/**
 * Side-by-side lanes for blocks whose DRAWN extents overlap. Greedy in start
 * order: each block takes the leftmost lane whose last block has ended, and
 * every block in one connected group of overlaps gets that group's lane count.
 * Blocks that only touch share a lane. Ties on top go by id, so the order is
 * stable across recompositions.
 */
internal fun weekGridLanes(blocks: List<Pair<String, BlockSpan>>): Map<String, GridLane> {
    val sorted = blocks.sortedWith(compareBy<Pair<String, BlockSpan>> { it.second.topMinute }.thenBy { it.first })
    val out = mutableMapOf<String, GridLane>()
    val group = mutableListOf<Pair<String, Int>>()
    val laneEnds = mutableListOf<Int>()
    var groupBottom = Int.MIN_VALUE
    fun closeGroup() {
        group.forEach { (id, lane) -> out[id] = GridLane(lane, laneEnds.size) }
        group.clear()
        laneEnds.clear()
    }
    for ((id, span) in sorted) {
        val bottom = span.topMinute + span.heightMinutes
        if (span.topMinute >= groupBottom) closeGroup()
        var lane = laneEnds.indexOfFirst { it <= span.topMinute }
        if (lane == -1) {
            lane = laneEnds.size
            laneEnds.add(bottom)
        } else {
            laneEnds[lane] = bottom
        }
        group.add(id to lane)
        groupBottom = if (group.size == 1) bottom else maxOf(groupBottom, bottom)
    }
    closeGroup()
    return out
}
