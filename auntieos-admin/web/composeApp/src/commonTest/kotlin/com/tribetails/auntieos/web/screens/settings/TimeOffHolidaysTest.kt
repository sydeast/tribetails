package com.tribetails.auntieos.web.screens.settings

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Desktop console Time Off panel: one name per holiday (#1947) and company
 * holidays listed next closure first (#1979). Same cases as the Android
 * `TimeOffHolidaysTest` and the web `settingsFormat.test.ts`.
 */
class TimeOffHolidaysTest {

    // ── #1947: one name per holiday, read off the preset catalog ───────────

    @Test
    fun columbusSwitchUsesThePresetName() {
        val columbus = US_OBSERVED_HOLIDAYS.first { it.first == "columbus" }
        assertEquals("Indigenous Peoples' Day (Columbus Day)", columbus.second)
        assertEquals(US_HOLIDAY_PRESETS.first { it.id == "indigenous_columbus" }.name, columbus.second)
    }

    @Test
    fun everySwitchNameIsAPresetName() {
        assertEquals(US_HOLIDAY_PRESETS.map { it.name }, US_OBSERVED_HOLIDAYS.map { it.second })
    }

    @Test
    fun storedObservedIdsStayAsTheyAre() {
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
    fun rowsRunByTheDateEachNextFallsOn() {
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
    fun eachRowKeepsItsStoredPositionForRemove() {
        val stored = listOf("yearly:08-14|Summer break", "yearly:04-20|Spring B", "2026-12-16|Staff day")
        val first = companyHolidayRows(stored, today).first()
        assertEquals("Staff day", first.closure.name)
        assertEquals(2, first.index)
        assertEquals(
            listOf("yearly:08-14|Summer break", "yearly:04-20|Spring B"),
            stored.filterIndexed { i, _ -> i != first.index },
        )
    }

    @Test
    fun aClosureOnTodayIsStillUpcoming() {
        val rows = companyHolidayRows(listOf("2026-12-01|Later", "$today|Today"), today)
        assertEquals(listOf("Today", "Later"), rows.map { it.closure.name })
    }

    @Test
    fun passedOneTimeClosuresComeAfterUpcomingOldestFirst() {
        val rows = companyHolidayRows(listOf("2025-06-01|Old B", "2026-12-25|Upcoming", "2025-01-01|Old A"), today)
        assertEquals(listOf("Upcoming", "Old A", "Old B"), rows.map { it.closure.name })
        assertEquals(listOf("2026-12-25", null, null), rows.map { it.next })
    }

    @Test
    fun anUnreadableRowGoesLast() {
        val rows = companyHolidayRows(listOf("not a closure", "2025-01-01|Old", "2026-12-25|Upcoming"), today)
        assertEquals(listOf("2026-12-25|Upcoming", "2025-01-01|Old", "not a closure"), rows.map { it.entry })
    }

    @Test
    fun sameDayTieBrokenByNameThenStoredPosition() {
        val rows = companyHolidayRows(
            listOf("yearly:12-25|Zoo day", "2026-12-25|Christmas", "yearly:12-25|Christmas"),
            today,
        )
        assertEquals(listOf(1, 2, 0), rows.map { it.index })
    }

    @Test
    fun aYearlyRowReadsAsARuleNotTheStoredTag() {
        val row = companyHolidayRows(listOf("yearly-nth:10-1-2|Indigenous Peoples' Day (Columbus Day)"), today).single()
        assertEquals("Every year, 2nd Monday of October", describeClosureRecurrence(row.closure))
        assertEquals("2027-10-11", row.next)
    }

    @Test
    fun aLastWeekdayRuleResolves() {
        val row = companyHolidayRows(listOf("yearly-last:05-1|Memorial Day"), today).single()
        assertEquals("Every year, last Monday of May", describeClosureRecurrence(row.closure))
        assertEquals("2027-05-31", row.next)
    }

    @Test
    fun noEntriesGivesNoRows() {
        assertEquals(emptyList(), companyHolidayRows(emptyList(), today))
    }
}
