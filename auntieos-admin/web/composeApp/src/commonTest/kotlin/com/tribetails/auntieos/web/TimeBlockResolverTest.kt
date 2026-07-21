package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.TimeBlockDefinition
import com.tribetails.auntieos.web.data.resolveTimeBlock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * §A.8 time-block resolver: map a session startTime onto the Business-Settings
 * TimeBlockDefinition whose window contains it. Pure + platform-agnostic so the
 * label ("Evening block") can render on Auntie Time / Bookings / create chips.
 */
class TimeBlockResolverTest {

    private val blocks = listOf(
        TimeBlockDefinition(id = "morning", label = "Morning", startTime = "08:00", endTime = "11:00"),
        TimeBlockDefinition(id = "midday", label = "Midday", startTime = "11:00", endTime = "15:00"),
        TimeBlockDefinition(id = "evening", label = "Evening", startTime = "17:00", endTime = "21:00"),
    )

    @Test
    fun `matches the block whose window contains the time`() {
        assertEquals("Midday", resolveTimeBlock("13:30", blocks)?.label)
        assertEquals("Morning", resolveTimeBlock("08:00", blocks)?.label)
    }

    @Test
    fun `start is inclusive, end is exclusive`() {
        // 11:00 belongs to Midday (its start), not Morning (its end).
        assertEquals("Midday", resolveTimeBlock("11:00", blocks)?.label)
    }

    @Test
    fun `parses HH-mm out of an ISO datetime startTime`() {
        assertEquals("Evening", resolveTimeBlock("2026-06-03T18:45:00Z", blocks)?.label)
    }

    @Test
    fun `returns null when no block contains the time (gap between windows)`() {
        assertNull(resolveTimeBlock("16:00", blocks)) // 15:00-17:00 is a gap
    }

    @Test
    fun `returns null for blank or unparseable startTime`() {
        assertNull(resolveTimeBlock("", blocks))
        assertNull(resolveTimeBlock("not-a-time", blocks))
    }

    @Test
    fun `skips inactive blocks`() {
        val withInactive = blocks.map { if (it.id == "midday") it.copy(isActive = false) else it }
        assertNull(resolveTimeBlock("13:30", withInactive))
    }
}
