package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.ui.components.monthGrid
import com.tribetails.auntieos.web.ui.components.nextMonth
import com.tribetails.auntieos.web.ui.components.prevMonth
import kotlinx.datetime.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure month-grid logic behind the wasm-safe date picker (B1). The shipped
 * Material3 DatePickerDialog cannot render on wasm and freezes the app, so the
 * picker is rebuilt from primitives over this Monday-start calendar matrix.
 */
class CalendarMonthTest {

    @Test
    fun `June 2026 starts on Monday so first cell is the 1st`() {
        // The live Schedule month view shows Mon column = 1, 8, 15, 22, 29.
        val grid = monthGrid(2026, 6)
        assertEquals(LocalDate(2026, 6, 1), grid[0][0])
    }

    @Test
    fun `every week row has exactly seven cells`() {
        val grid = monthGrid(2026, 6)
        grid.forEach { week -> assertEquals(7, week.size) }
    }

    @Test
    fun `June 2026 spans five week rows ending on the 30th`() {
        val grid = monthGrid(2026, 6)
        assertEquals(5, grid.size)
        // June 30 2026 is a Tuesday -> index 1 of the final row; rest pad null.
        assertEquals(LocalDate(2026, 6, 30), grid[4][1])
        assertNull(grid[4][2])
        assertNull(grid[4][6])
    }

    @Test
    fun `a month starting Sunday gets six leading blanks under Monday-start`() {
        // Feb 1 2026 is a Sunday -> Mon..Sat are padding, Sunday holds the 1st.
        val grid = monthGrid(2026, 2)
        for (i in 0..5) assertNull(grid[0][i])
        assertEquals(LocalDate(2026, 2, 1), grid[0][6])
    }

    @Test
    fun `grid contains every day of the month exactly once`() {
        val grid = monthGrid(2026, 2)
        val days = grid.flatten().filterNotNull().filter { it.monthNumber == 2 }
        assertEquals(28, days.size) // 2026 is not a leap year
        assertEquals((1..28).toList(), days.map { it.dayOfMonth })
    }

    @Test
    fun `prevMonth and nextMonth roll the year boundary`() {
        assertEquals(2025 to 12, prevMonth(2026, 1))
        assertEquals(2027 to 1, nextMonth(2026, 12))
        assertEquals(2026 to 5, prevMonth(2026, 6))
        assertEquals(2026 to 7, nextMonth(2026, 6))
    }

    @Test
    fun `no real day ever lands in the wrong weekday column`() {
        // Spot-check: in June 2026 the 30th (Tuesday) must sit in column 1.
        val grid = monthGrid(2026, 6)
        val cell = grid.flatten().withIndex().first { it.value == LocalDate(2026, 6, 30) }
        assertTrue(cell.index % 7 == 1)
    }
}
