package com.tribetails.auntieos.ui.admin.scheduling

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.util.TimeZone

/**
 * AO-25: pure date math for the New-booking-request form. Assertions are
 * TZ-independent (counts, weekday convention, ordering), not exact epoch ms.
 */
class NewBookingMathTest {

    @Test
    fun `jsWeekday maps Monday to 1 and Sunday to 0`() {
        assertEquals(1, NewBookingMath.jsWeekday(LocalDate.of(2027, 8, 2)))  // Monday
        assertEquals(0, NewBookingMath.jsWeekday(LocalDate.of(2027, 8, 1)))  // Sunday
        assertEquals(6, NewBookingMath.jsWeekday(LocalDate.of(2027, 8, 7)))  // Saturday
    }

    @Test
    fun `expandWeekly yields one occurrence per selected weekday per week`() {
        // Mon(1) + Wed(3), 2 weeks -> 4 visits.
        val ms = NewBookingMath.expandWeekly(
            startDate = LocalDate.of(2027, 8, 2),
            hour = 9, minute = 0,
            weekdays = setOf(1, 3),
            weeks = 2,
        )
        assertEquals(4, ms.size)
        // ascending
        assertEquals(ms.sorted(), ms)
    }

    @Test
    fun `expandWeekly is empty with no weekday or non-positive weeks`() {
        assertTrue(NewBookingMath.expandWeekly(LocalDate.of(2027, 8, 2), 9, 0, emptySet(), 2).isEmpty())
        assertTrue(NewBookingMath.expandWeekly(LocalDate.of(2027, 8, 2), 9, 0, setOf(1), 0).isEmpty())
    }

    @Test
    fun `visitMs drops nulls, de-dupes, and sorts`() {
        val a = NewBookingMath.localMs(LocalDate.of(2027, 8, 3), 9, 0)
        val b = NewBookingMath.localMs(LocalDate.of(2027, 8, 10), 9, 0)
        val ms = NewBookingMath.visitMs(listOf(b, null, a, a))
        assertEquals(2, ms.size)
        assertTrue(ms[0] < ms[1])
    }

    @Test
    fun `allInFuture honors the one-minute grace`() {
        val now = 1_000_000_000_000L
        assertTrue(NewBookingMath.allInFuture(listOf(now + 1000, now + 5000), now))
        assertTrue(NewBookingMath.allInFuture(listOf(now - 30_000), now))   // within grace
        assertFalse(NewBookingMath.allInFuture(listOf(now + 5000, now - 120_000), now))
    }

    /**
     * The M3 DatePicker round trip, IN EVERY ZONE, not just the one the CI box
     * happens to sit in. The dialog seeded the picker through the device zone and
     * read the answer back through UTC; the two agree only at or west of
     * Greenwich, so in Auckland the picker opened on the day BEFORE the one it
     * was handed, and confirming without moving booked a visit 24 hours early.
     * Pinning both directions to one zone is the fix, and this is what holds it.
     */
    @Test
    fun `picker seed and read round-trip to the same day in every zone`() {
        val original = TimeZone.getDefault()
        try {
            for (zone in listOf("Pacific/Auckland", "Asia/Tokyo", "UTC", "America/Chicago", "Pacific/Honolulu")) {
                TimeZone.setDefault(TimeZone.getTimeZone(zone))
                for (date in listOf(
                    LocalDate.of(2027, 8, 16),
                    LocalDate.of(2027, 1, 1),
                    LocalDate.of(2027, 12, 31),
                    LocalDate.of(2028, 2, 29),
                )) {
                    assertEquals(
                        "round trip broke in $zone",
                        date,
                        NewBookingMath.pickerPickedDate(NewBookingMath.pickerSeedMs(date)),
                    )
                }
            }
        } finally {
            TimeZone.setDefault(original)
        }
    }

    @Test
    fun `picker seed really is UTC midnight, which is the contract M3 states`() {
        // 2027-08-16T00:00:00Z. A seed computed in any other zone lands on a
        // different UTC calendar day and is what caused the off-by-one.
        assertEquals(1_818_374_400_000L, NewBookingMath.pickerSeedMs(LocalDate.of(2027, 8, 16)))
    }
}
