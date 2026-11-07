package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.kinfolkChanges
import kotlinx.datetime.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #1584. Operator ruling, 2026-11-05 docket: join dates run 2025 through today. */
class JoinDateTest {
    private val today = LocalDate.parse("2026-11-06")

    @Test
    fun joinDatesRunFrom2025ThroughToday() {
        assertTrue(isJoinDateInRange("2025-01-01", today))
        assertTrue(isJoinDateInRange("2026-11-06", today))
        assertFalse(isJoinDateInRange("2024-12-31", today))
        assertFalse(isJoinDateInRange("2026-11-07", today))
        assertFalse(isJoinDateInRange("1900-01-15", today))
        assertFalse(isJoinDateInRange("2099-06-01", today))
        assertFalse(isJoinDateInRange("2025-02-30", today))
    }

    @Test
    fun outOfRangeDaysAreRefusedWithTheMessage() {
        assertEquals(JOIN_DATE_RANGE_MESSAGE, joinDateRangeError("1900-01-15", "", today))
        assertEquals(JOIN_DATE_RANGE_MESSAGE, joinDateRangeError("2099-06-01", "2099-06-01", today))
        assertEquals("Pick a join date from 2025 through today.", JOIN_DATE_RANGE_MESSAGE)
    }

    @Test
    fun blankAndInRangeMayBeSaved() {
        assertNull(joinDateRangeError("", "2026-01-04", today))
        assertNull(joinDateRangeError("2026-01-04", "", today))
    }

    @Test
    fun legacyTextLeftAsStoredDoesNotBlockASave() {
        assertNull(joinDateRangeError("07/24/2026", "07/24/2026", today))
        assertEquals(JOIN_DATE_RANGE_MESSAGE, joinDateRangeError("sometime", "07/24/2026", today))
    }

    @Test
    fun aPickedJoinDateIsWrittenAndAnUntouchedOneIsNot() {
        val loaded = Kinfolk(_id = "k1", joinDate = "2026-01-04")
        val untouched = loaded.copy(joinDate = keepStoredUnlessEdited("2026-01-04", loaded.joinDate))
        assertTrue(kinfolkChanges(loaded, untouched).isEmpty())
        val picked = loaded.copy(joinDate = keepStoredUnlessEdited("2026-03-05", loaded.joinDate))
        assertEquals(listOf(listOf("joinDate")), kinfolkChanges(loaded, picked).map { it.path })
    }
}
