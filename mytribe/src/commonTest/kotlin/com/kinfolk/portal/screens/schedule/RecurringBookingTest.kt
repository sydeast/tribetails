package com.kinfolk.portal.screens.schedule

import com.kinfolk.portal.portal.Service
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.LocalTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Stage 3 / 16.3 - pure weekly-recurrence expansion + validation, plus the
 * #541/#543 KinCare-slot shape and the #546/#547 estimate the whole wizard
 * prices from. The web mirror is mytribe/web/src/lib/bookingWizardLogic.test.ts.
 */
class RecurringBookingTest {

    private val utc = TimeZone.UTC

    private fun service(id: String, name: String, priceCents: Long?, priceMinCents: Long? = null) = Service(
        id = id,
        name = name,
        category = null,
        description = null,
        priceCents = priceCents,
        priceMinCents = priceMinCents,
        priceMaxCents = null,
        isOvernight = false,
        iconKey = null,
    )

    private val thirtyMinute = service("30Minute", "30 Minute", 2500)
    private val sixtyMinute = service("60Minute", "60 Minute", 4500)
    private val ranged = service("ranged", "Ranged", null, priceMinCents = 800)
    private val unpriced = service("unpriced", "Unpriced", null)
    private val walk = service("s1", "Walk", 1000)
    private val catalog = listOf(walk, thirtyMinute, sixtyMinute, ranged, unpriced)

    private fun slot(serviceId: String, time: String, n: Int = 1) =
        KinCareSlot(slotId = "$serviceId-$n", serviceId = serviceId, time = time)

    // A fixed midnight reference so "today 09:00" is always in the future.
    private fun midnightMs(y: Int, m: Int, d: Int): Long =
        LocalDateTime(y, m, d, 0, 0).toInstant(utc).toEpochMilliseconds()

    @Test
    fun expandsEveryChosenWeekdayForEachWeek() {
        val now = midnightMs(2026, 6, 1)
        val visits = buildWeeklyVisits(
            nowMs = now, weeklyDays = (0..6).toSet(), weeks = 1,
            slots = listOf(slot("s1", "09:00")), services = catalog, tz = utc,
        )
        // All 7 weekdays, one week, all at 09:00 > midnight -> 7 future visits.
        assertEquals(7, visits.size)
        // strictly ascending by start time
        assertTrue(visits.zipWithNext().all { (a, b) -> a.startTimeMs < b.startTimeMs })
        assertTrue(visits.all { it.startTimeMs > now && it.serviceId == "s1" && it.priceCents == 1000L })
    }

    @Test
    fun twoDaysTwoWeeksGivesFour() {
        val now = midnightMs(2026, 6, 1)
        val day0 = weekdayIndex(LocalDate(2026, 6, 1))
        val day2 = (day0 + 2) % 7
        val visits = buildWeeklyVisits(now, setOf(day0, day2), 2, listOf(slot("s1", "08:30")), catalog, utc)
        assertEquals(4, visits.size)
    }

    /** #541 + #543 on the weekly pattern: every KinCare repeats on every chosen day. */
    @Test
    fun everyKinCareRepeatsOnEveryChosenDayInTimeOrder() {
        val now = midnightMs(2026, 6, 1)
        val day0 = weekdayIndex(LocalDate(2026, 6, 1))
        val day2 = (day0 + 2) % 7
        val visits = buildWeeklyVisits(
            now, setOf(day0, day2), 2,
            // Handed over out of order on purpose: the day must still read 09:00 first.
            listOf(slot("60Minute", "17:00"), slot("30Minute", "09:00")),
            catalog, utc,
        )
        assertEquals(8, visits.size)
        assertEquals(listOf("30Minute", "60Minute"), visits.take(2).map { it.serviceId })
        assertTrue(visits.zipWithNext().all { (a, b) -> a.startTimeMs < b.startTimeMs })
    }

    @Test
    fun pastOccurrencesAreFiltered() {
        // now = a day at 10:00; only that same weekday at 09:00 would match within
        // 1 week, but 09:00 < 10:00 (past) and it doesn't recur again until week 2.
        val today = LocalDate(2026, 6, 1)
        val now = LocalDateTime(2026, 6, 1, 10, 0).toInstant(utc).toEpochMilliseconds()
        val visits = buildWeeklyVisits(now, setOf(weekdayIndex(today)), 1, listOf(slot("s1", "09:00")), catalog, utc)
        assertEquals(0, visits.size)
    }

    @Test
    fun capsAtMax() {
        val now = midnightMs(2026, 6, 1)
        val visits = buildWeeklyVisits(now, (0..6).toSet(), 8, listOf(slot("s1", "09:00")), catalog, utc)
        assertEquals(MAX_RECURRING_VISITS, visits.size) // 56 potential -> capped to 26
    }

    /** The cap counts VISITS, so more KinCares per day means fewer days survive it. */
    @Test
    fun capCountsVisitsNotDaysAndKeepsTheEarliestRun() {
        val now = midnightMs(2026, 6, 1)
        val slots = listOf(slot("30Minute", "09:00"), slot("60Minute", "17:00"))
        val visits = buildWeeklyVisits(now, (0..6).toSet(), 8, slots, catalog, utc)
        assertEquals(MAX_RECURRING_VISITS, visits.size)
        assertEquals(112, weeklyPotentialCount((0..6).toSet(), 8, slots.size))
        assertTrue(visits.zipWithNext().all { (a, b) -> a.startTimeMs < b.startTimeMs })
    }

    @Test
    fun potentialCountExposesTruncation() {
        // weeklyPotentialCount is the INTENDED count (days x weeks x KinCares); when
        // it exceeds the emitted size, the wizard surfaces a fail-loud cap warning.
        assertEquals(56, weeklyPotentialCount((0..6).toSet(), 8, 1))
        assertEquals(8, weeklyPotentialCount(setOf(1, 3), 4, 1))
        assertEquals(16, weeklyPotentialCount(setOf(1, 3), 4, 2))
        assertEquals(0, weeklyPotentialCount(setOf(1), 0, 3))
        val now = midnightMs(2026, 6, 1)
        val emitted = buildWeeklyVisits(now, (0..6).toSet(), 8, listOf(slot("s1", "09:00")), catalog, utc).size
        assertTrue(weeklyPotentialCount((0..6).toSet(), 8, 1) > emitted) // truncation is detectable
    }

    @Test
    fun emptyDaysZeroWeeksOrNoKinCareYieldsNothing() {
        val now = midnightMs(2026, 6, 1)
        val slots = listOf(slot("s1", "09:00"))
        assertTrue(buildWeeklyVisits(now, emptySet(), 4, slots, catalog, utc).isEmpty())
        assertTrue(buildWeeklyVisits(now, setOf(1), 0, slots, catalog, utc).isEmpty())
        assertTrue(buildWeeklyVisits(now, setOf(1), 4, emptyList(), catalog, utc).isEmpty())
    }

    @Test
    fun weeklyVisitsBlockerValidates() {
        val ok = listOf(slot("s1", "09:00"))
        assertNotNull(weeklyVisitsBlocker(emptySet(), 4, ok))
        assertNotNull(weeklyVisitsBlocker(setOf(1), 0, ok))
        assertNotNull(weeklyVisitsBlocker(setOf(1), 4, listOf(slot("s1", "bad"))))
        assertNull(weeklyVisitsBlocker(setOf(1, 3), 4, ok))
    }

    /** #541 + #543: the KinCare list is what a booking day is made of. */
    @Test
    fun slotsBlockerAllowsSeveralKinCaresButNotTheSameOneTwice() {
        assertEquals("Add at least one KinCare Duration.", slotsBlocker(emptyList()))
        assertEquals(
            "Enter every KinCare time as HH:MM.",
            slotsBlocker(listOf(slot("s1", "09:00"), slot("s1", "bad", 2))),
        )
        // #541: two different durations, even at the same time.
        assertNull(slotsBlocker(listOf(slot("30Minute", "09:00"), slot("60Minute", "09:00"))))
        // #543: the same duration twice, at two times.
        assertNull(slotsBlocker(listOf(slot("30Minute", "09:00"), slot("30Minute", "17:00", 2))))
        assertEquals(
            "Two KinCares have the same duration at the same time. Change one of the times.",
            slotsBlocker(listOf(slot("30Minute", "09:00"), slot("30Minute", "09:00", 2))),
        )
    }

    @Test
    fun buildVisitsEmitsOnePerDatePerKinCareSortedByStart() {
        val dates = listOf(LocalDate(2026, 9, 6), LocalDate(2026, 9, 4))
        val visits = buildVisits(dates, listOf(slot("60Minute", "17:00"), slot("30Minute", "09:00")), catalog, utc)
        assertEquals(4, visits.size)
        assertTrue(visits.zipWithNext().all { (a, b) -> a.startTimeMs < b.startTimeMs })
        assertEquals(listOf("30 Minute", "60 Minute", "30 Minute", "60 Minute"), visits.map { it.serviceName })
    }

    @Test
    fun buildVisitsSkipsAKinCareWhoseServiceOrTimeCannotBeResolved() {
        val visits = buildVisits(
            listOf(LocalDate(2026, 9, 4)),
            listOf(slot("gone", "09:00"), slot("30Minute", "bad", 2), slot("30Minute", "10:00", 3)),
            catalog, utc,
        )
        assertEquals(1, visits.size)
        assertEquals("30Minute", visits.single().serviceId)
    }

    /**
     * #546's worked example, straight off the walk that filed it: three visits
     * of a $25.00 KinCare. The old wizard printed $25.00 here.
     */
    @Test
    fun threeVisitsOfATwentyFiveDollarKinCareEstimateAtSeventyFive() {
        val dates = listOf(LocalDate(2026, 8, 26), LocalDate(2026, 8, 27), LocalDate(2026, 8, 28))
        val visits = buildVisits(dates, listOf(slot("30Minute", "09:00")), catalog, utc)
        assertEquals(3, visits.size)
        val e = estimateBookingTotal(visits, catalog)
        assertEquals(BookingEstimate(totalCents = 7500, exactVisits = 3, floorVisits = 0, unpricedVisits = 0), e)
        assertEquals("$75.00", formatEstimate(e))
    }

    @Test
    fun estimateAddsUpAMixedDayAndARepeatedKinCare() {
        val dates = listOf(LocalDate(2026, 8, 26), LocalDate(2026, 8, 27), LocalDate(2026, 8, 28))
        // #541: three days of a $25.00 and a $45.00 = $210.00.
        val mixed = buildVisits(dates, listOf(slot("30Minute", "09:00"), slot("60Minute", "17:00")), catalog, utc)
        assertEquals(6, mixed.size)
        assertEquals("$210.00", formatEstimate(estimateBookingTotal(mixed, catalog)))
        // #543: three days of two $25.00s = $150.00.
        val twice = buildVisits(dates, listOf(slot("30Minute", "09:00"), slot("30Minute", "17:00", 2)), catalog, utc)
        assertEquals("$150.00", formatEstimate(estimateBookingTotal(twice, catalog)))
    }

    @Test
    fun estimateNeverInventsANumberItDoesNotHave() {
        val dates = listOf(LocalDate(2026, 8, 26))
        assertEquals("—", formatEstimate(estimateBookingTotal(emptyList(), catalog)))
        val floored = buildVisits(dates, listOf(slot("30Minute", "09:00"), slot("ranged", "17:00")), catalog, utc)
        assertEquals("from $33.00", formatEstimate(estimateBookingTotal(floored, catalog)))
        val none = buildVisits(dates, listOf(slot("unpriced", "09:00")), catalog, utc)
        assertEquals("Pending", formatEstimate(estimateBookingTotal(none, catalog)))
    }

    /**
     * #547, and the spelling comes from
     * docs/superpowers/specs/2026-08-23-visit-date-rendering-design.md:
     * enumerate, never summarise.
     */
    @Test
    fun plannedVisitsAreEnumeratedInTheSpecSpelling() {
        val visits = buildVisits(
            listOf(LocalDate(2026, 9, 6), LocalDate(2026, 9, 4)),
            listOf(slot("30Minute", "09:00")),
            catalog, utc,
        )
        val rendered = renderPlannedVisits(visits, utc)
        assertEquals(listOf("Fri, Sep 4 at 9:00 AM", "Sun, Sep 6 at 9:00 AM"), rendered.map { plannedVisitLine(it) })
        assertEquals("30 Minute", rendered.first().serviceName)
    }

    @Test
    fun plannedVisitsNameBothKinCaresOfADayAndKeyThemApart() {
        val visits = buildVisits(
            listOf(LocalDate(2026, 9, 4)),
            listOf(slot("30Minute", "09:00"), slot("30Minute", "17:30", 2)),
            catalog, utc,
        )
        val rendered = renderPlannedVisits(visits, utc)
        assertEquals(listOf("Fri, Sep 4 at 9:00 AM", "Fri, Sep 4 at 5:30 PM"), rendered.map { plannedVisitLine(it) })
        assertEquals(2, rendered.map { it.key }.toSet().size)
    }

    @Test
    fun plannedVisitsRenderMidnightAndNoonAsTwelve() {
        val visits = buildVisits(
            listOf(LocalDate(2026, 9, 4)),
            listOf(slot("30Minute", "00:00"), slot("60Minute", "12:00")),
            catalog, utc,
        )
        assertEquals(listOf("12:00 AM", "12:00 PM"), renderPlannedVisits(visits, utc).map { it.time })
    }

    @Test
    fun summariseSlotsCountsRepeatsRatherThanRepeatingTheName() {
        val slots = listOf(slot("30Minute", "09:00"), slot("30Minute", "17:00", 2), slot("60Minute", "12:00"))
        assertEquals("2 × 30 Minute, 60 Minute", summariseSlots(slots, catalog))
        assertEquals("", summariseSlots(emptyList(), catalog))
    }

    @Test
    fun parseHourMinute() {
        assertEquals(LocalTime(9, 30), parseHourMinuteOrNull("09:30"))
        assertNull(parseHourMinuteOrNull("9"))
        assertNull(parseHourMinuteOrNull("ab:cd"))
    }
}
