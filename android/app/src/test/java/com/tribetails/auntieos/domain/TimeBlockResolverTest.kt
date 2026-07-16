package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.TimeBlockDefinition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** §A.8 time-block resolver, pure JVM helper. Mirrors the web TimeBlockResolverTest. */
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
    fun `start inclusive end exclusive`() {
        assertEquals("Midday", resolveTimeBlock("11:00", blocks)?.label)
    }

    @Test
    fun `parses HH mm from ISO datetime`() {
        assertEquals("Evening", resolveTimeBlock("2026-06-03T18:45:00Z", blocks)?.label)
    }

    @Test
    fun `null in a gap between windows`() {
        assertNull(resolveTimeBlock("16:00", blocks))
    }

    @Test
    fun `null for blank or unparseable`() {
        assertNull(resolveTimeBlock("", blocks))
        assertNull(resolveTimeBlock("not-a-time", blocks))
    }

    @Test
    fun `skips inactive blocks`() {
        val withInactive = blocks.map { if (it.id == "midday") it.copy(isActive = false) else it }
        assertNull(resolveTimeBlock("13:30", withInactive))
    }
}
