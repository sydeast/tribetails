package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.screens.kintales.kinTaleShortDateTime
import kotlin.test.Test
import kotlin.test.assertEquals

/** #1599: list dates from another year say which year, on the desktop console. */
class RowDateYearTest {
    @Test
    fun humanizeDateAddsTheYearOnlyWhenItDiffers() {
        assertEquals("Jul 2", humanizeDate("2026-07-02", "2026-11-06"))
        assertEquals("Jul 2, 2025", humanizeDate("2025-07-02", "2026-11-06"))
        // Without a reference day the label stays bare, as before.
        assertEquals("Jul 2", humanizeDate("2025-07-02"))
    }

    @Test
    fun kinTaleRowsCarryAnotherYear() {
        assertEquals("Nov 5 · 14:02", kinTaleShortDateTime("2026-11-05T14:02:00Z", 2026))
        assertEquals("Sep 3, 2025 · 14:02", kinTaleShortDateTime("2025-09-03T14:02:00Z", 2026))
    }
}
