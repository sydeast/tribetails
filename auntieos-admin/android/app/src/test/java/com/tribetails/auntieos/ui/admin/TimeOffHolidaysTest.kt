package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Time off panel: one name per holiday (#1947) and company holidays listed
 * next closure first (#1979). Mirrors the web cases in
 * `auntieos-admin/src/lib/settingsFormat.test.ts`.
 */
class TimeOffHolidaysTest {

    private fun presetName(id: String) = US_HOLIDAY_PRESETS.first { it.id == id }.name

    // ── #1947: switch names come from the quick-add chips ──────────────────

    @Test
    fun `the columbus switch has the same name as its quick-add chip`() {
        val columbus = US_OBSERVED_HOLIDAYS.first { it.first == "columbus" }
        assertEquals(presetName("indigenous_columbus"), columbus.second)
    }

    @Test
    fun `every switch name is a chip name, so no holiday has two names`() {
        assertEquals(US_HOLIDAY_PRESETS.map { it.name }, US_OBSERVED_HOLIDAYS.map { it.second })
    }

    @Test
    fun `the stored observed ids stay as they are`() {
        assertEquals(
            listOf(
                "new_years", "mlk", "presidents", "memorial", "juneteenth", "independence",
                "labor", "columbus", "veterans", "thanksgiving", "christmas",
            ),
            US_OBSERVED_HOLIDAYS.map { it.first },
        )
    }

    // ── #1979: company holidays in date order ──────────────────────────────

    private val today = "2026-11-12"

    @Test
    fun `yearly and one-time rows are listed by the date each next falls on`() {
        val stored = listOf(
            "yearly:08-14|Summer break",
            "yearly:09-02|Owner birthday",
            "yearly:04-14|Spring A",
            "yearly:04-20|Spring B",
            "yearly:04-15|Spring C",
            "yearly:04-13|Spring D",
            "2026-12-16|Staff day",
            "yearly-nth:11-4-4|Thanksgiving",
        )
        val rows = companyHolidayRows(stored, today)
        assertEquals(
            listOf("Thanksgiving", "Staff day", "Spring D", "Spring A", "Spring C", "Spring B", "Summer break", "Owner birthday"),
            rows.map { it.closure.name },
        )
        assertEquals(
            listOf("2026-11-26", "2026-12-16", "2027-04-13", "2027-04-14", "2027-04-15", "2027-04-20", "2027-08-14", "2027-09-02"),
            rows.map { it.next },
        )
    }

    @Test
    fun `each row keeps its stored position so Remove takes out the right one`() {
        val rows = companyHolidayRows(listOf("2027-01-05|Later", "2026-12-01|Sooner"), today)
        assertEquals(listOf(1 to "2026-12-01|Sooner", 0 to "2027-01-05|Later"), rows.map { it.index to it.entry })
    }

    @Test
    fun `removing a sorted row by its stored index leaves the rest in stored order`() {
        val stored = listOf("yearly:08-14|Summer break", "yearly:04-20|Spring B", "2026-12-16|Staff day")
        val first = companyHolidayRows(stored, today).first()
        assertEquals("Staff day", first.closure.name)
        assertEquals(
            listOf("yearly:08-14|Summer break", "yearly:04-20|Spring B"),
            stored.filterIndexed { i, _ -> i != first.index },
        )
    }

    @Test
    fun `a closure on today itself is still upcoming`() {
        val rows = companyHolidayRows(listOf("2026-12-01|Later", "$today|Today"), today)
        assertEquals(listOf("Today", "Later"), rows.map { it.closure.name })
    }

    @Test
    fun `one-time closures that have passed come after every upcoming one, oldest first`() {
        val rows = companyHolidayRows(listOf("2025-06-01|Old B", "2026-12-25|Upcoming", "2025-01-01|Old A"), today)
        assertEquals(listOf("Upcoming", "Old A", "Old B"), rows.map { it.closure.name })
        assertEquals(listOf("2026-12-25", null, null), rows.map { it.next })
    }

    @Test
    fun `a row that cannot be read goes last, after passed closures`() {
        val rows = companyHolidayRows(listOf("not a closure", "2025-01-01|Old", "2026-12-25|Upcoming"), today)
        assertEquals(listOf("2026-12-25|Upcoming", "2025-01-01|Old", "not a closure"), rows.map { it.entry })
    }

    @Test
    fun `a same-day tie is broken by name, then by stored position`() {
        val rows = companyHolidayRows(
            listOf("yearly:12-25|Zoo day", "2026-12-25|Christmas", "yearly:12-25|Christmas"),
            today,
        )
        assertEquals(listOf(1, 2, 0), rows.map { it.index })
    }

    @Test
    fun `no entries gives no rows`() {
        assertEquals(emptyList<CompanyHolidayRow>(), companyHolidayRows(emptyList(), today))
    }

    @Test
    fun `the order flips at New Year, by the day passed in`() {
        val stored = listOf("yearly:01-01|New Year's Day", "yearly:12-31|Year end")
        val dec31 = companyHolidayRows(stored, "2026-12-31")
        assertEquals(listOf("Year end", "New Year's Day"), dec31.map { it.closure.name })
        assertEquals(listOf("2026-12-31", "2027-01-01"), dec31.map { it.next })
        val jan1 = companyHolidayRows(stored, "2027-01-01")
        assertEquals(listOf("New Year's Day", "Year end"), jan1.map { it.closure.name })
        assertEquals(listOf("2027-01-01", "2027-12-31"), jan1.map { it.next })
    }

    @Test
    fun `a Feb 29 closure lists at its next date, Feb 28 in a non-leap year`() {
        val rows = companyHolidayRows(listOf("yearly:03-01|March first", "yearly:02-29|Leap day"), "2026-11-12")
        assertEquals(listOf("Leap day", "March first"), rows.map { it.closure.name })
        assertEquals(listOf("2027-02-28", "2027-03-01"), rows.map { it.next })
    }
}
