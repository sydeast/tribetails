package com.tribetails.auntieos.web.ui.components

import kotlinx.datetime.LocalDate
import kotlinx.datetime.daysUntil
import kotlinx.datetime.isoDayNumber

/**
 * Pure calendar-grid logic behind the wasm-safe date picker (B1).
 *
 * Material3's DatePickerDialog cannot render on wasm — it mounts an invisible
 * modal scrim that swallows every pointer event and freezes the whole app until
 * a full reload. So the picker is rebuilt from Compose primitives over this
 * Monday-start month matrix (matching the Schedule month view's Mon..Sun layout).
 *
 * @return six-or-fewer week rows, each exactly 7 cells. A cell is the [LocalDate]
 *   for that day, or null for the leading/trailing padding outside the month.
 */
fun monthGrid(year: Int, month: Int): List<List<LocalDate?>> {
    val firstOfMonth = LocalDate(year, month, 1)
    // Monday-start: Monday(iso 1) -> 0 leading blanks ... Sunday(iso 7) -> 6.
    val leadingBlanks = firstOfMonth.dayOfWeek.isoDayNumber - 1

    val (nextYear, nextMonthNum) = nextMonth(year, month)
    val daysInMonth = firstOfMonth.daysUntil(LocalDate(nextYear, nextMonthNum, 1))

    val cells = ArrayList<LocalDate?>(42)
    repeat(leadingBlanks) { cells.add(null) }
    for (day in 1..daysInMonth) cells.add(LocalDate(year, month, day))
    while (cells.size % 7 != 0) cells.add(null)

    return cells.chunked(7)
}

fun prevMonth(year: Int, month: Int): Pair<Int, Int> =
    if (month == 1) (year - 1) to 12 else year to (month - 1)

fun nextMonth(year: Int, month: Int): Pair<Int, Int> =
    if (month == 12) (year + 1) to 1 else year to (month + 1)
