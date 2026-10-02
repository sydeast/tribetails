package com.kinfolk.portal.screens.schedule
import com.kinfolk.portal.portal.BookingMode
import com.kinfolk.portal.portal.Service
import com.kinfolk.portal.portal.TimeBlock
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
/**
 * #1092: an overnight is twelve hours that can start at any time of day, so no
 * window can hold it. A KinCare in `startTimeServiceIds` books on the clock even
 * in a block-mode plan, and every other KinCare in that plan keeps its window.
 *
 * The web mirror is the "start-time KinCares in a block-mode plan (#1092)"
 * section of mytribe/web/src/lib/bookingWizardLogic.test.ts; both assert the
 * same facts about the same functions.
 */
class StartTimeServiceBookingTest {
    private val utc = TimeZone.UTC
    private fun service(id: String, name: String, priceCents: Long?) = Service(
        id = id,
        name = name,
        category = null,
        description = null,
        priceCents = priceCents,
        priceMinCents = null,
        priceMaxCents = null,
        isOvernight = false,
        iconKey = null,
    )
    private val thirtyMinute = service("30Minute", "30 Minute", 2500)
    private val overnight = service("Overnight", "Overnight", 15000)
    private val catalog = listOf(thirtyMinute, overnight)
    private val midday = TimeBlock("midday", "Midday", "11:00", "15:00", 240)
    private val evening = TimeBlock("evening", "Evening", "17:00", "21:00", 240)
    private val blockTiming = BookingTiming(BookingMode.TimeBlock, listOf(midday, evening))
    private val timing = blockTiming.copy(startTimeServiceIds = setOf("Overnight"))
    private val sep4 = LocalDate(2026, 9, 4) // a Friday
    private fun msAt(y: Int, m: Int, d: Int, hour: Int, minute: Int = 0): Long =
        LocalDateTime(y, m, d, hour, minute).toInstant(utc).toEpochMilliseconds()
    /** A KinCare in a named window. Its `time` is junk: a window slot must never read it. */
    private fun blockSlot(serviceId: String, blockId: String?, n: Int = 1) =
        KinCareSlot(slotId = "$serviceId-$blockId-$n", serviceId = serviceId, time = "nonsense", timeBlockId = blockId)
    /**
     * An overnight carrying BOTH a real window id and a clock time, so a mistake
     * that reads the window, or sends it, cannot pass by accident.
     */
    private fun overnightSlot(time: String, n: Int = 1) =
        KinCareSlot(slotId = "Overnight-$n", serviceId = "Overnight", time = time, timeBlockId = "midday")
    @Test
    fun `decides the mode per slot`() {
        assertTrue(serviceBooksAtStartTime("Overnight", timing))
        assertFalse(serviceBooksAtStartTime("30Minute", timing))
        assertEquals(BookingMode.SpecificTime, slotMode(overnightSlot("21:00"), timing))
        assertEquals(BookingMode.TimeBlock, slotMode(blockSlot("30Minute", "midday"), timing))
    }
    @Test
    fun `a timing without the list (an older server) treats nothing as start-time`() {
        assertFalse(serviceBooksAtStartTime("Overnight", blockTiming))
        val v = buildVisits(listOf(sep4), listOf(overnightSlot("21:00")), catalog, utc, blockTiming).single()
        assertEquals("midday", v.timeBlockId)
        assertEquals(msAt(2026, 9, 4, 11), v.startTimeMs)
    }
    @Test
    fun `sends a start-time visit at its clock with no window, beside a window visit that keeps its window`() {
        val visits = buildVisits(
            listOf(sep4),
            listOf(blockSlot("30Minute", "midday"), overnightSlot("21:00")),
            catalog,
            utc,
            timing,
        )
        assertEquals(2, visits.size)
        val (mid, night) = visits
        assertEquals("30Minute", mid.serviceId)
        assertEquals("midday", mid.timeBlockId)
        assertEquals(msAt(2026, 9, 4, 11), mid.startTimeMs)
        assertEquals("Overnight", night.serviceId)
        assertNull(night.timeBlockId)
        assertEquals(msAt(2026, 9, 4, 21), night.startTimeMs)
        // The server computes the twelve-hour end itself.
        assertNull(night.endTimeMs)
    }
    @Test
    fun `expands a weekly rule with the start-time KinCare on the clock and the other in its window`() {
        val visits = buildWeeklyVisits(
            nowMs = msAt(2026, 9, 4, 8),
            weeklyDays = setOf(5),
            weeks = 2,
            slots = listOf(overnightSlot("21:00"), blockSlot("30Minute", "evening")),
            services = catalog,
            tz = utc,
            timing = timing,
        )
        assertEquals(
            listOf(
                Triple("30Minute", "evening", msAt(2026, 9, 4, 17)),
                Triple("Overnight", null, msAt(2026, 9, 4, 21)),
                Triple("30Minute", "evening", msAt(2026, 9, 11, 17)),
                Triple("Overnight", null, msAt(2026, 9, 11, 21)),
            ),
            visits.map { Triple(it.serviceId, it.timeBlockId, it.startTimeMs) },
        )
    }
    @Test
    fun `does not ask a start-time KinCare for a window, but does ask it for a valid time`() {
        val noWindow = KinCareSlot("o", "Overnight", "21:00", null)
        assertNull(slotsBlocker(listOf(noWindow, blockSlot("30Minute", "midday")), timing))
        assertEquals(
            "Enter every KinCare time as HH:MM.",
            slotsBlocker(listOf(noWindow.copy(time = ""), blockSlot("30Minute", "midday")), timing),
        )
    }
    @Test
    fun `still asks the other KinCares in the plan for a window`() {
        assertEquals(
            "Choose a time block for every KinCare.",
            slotsBlocker(listOf(overnightSlot("21:00"), blockSlot("30Minute", null)), timing),
        )
    }
    @Test
    fun `keys a start-time duplicate on the clock, not on the stale window id`() {
        assertNull(slotsBlocker(listOf(overnightSlot("07:00"), overnightSlot("21:00", 2)), timing))
        assertEquals(
            "Two KinCares have the same duration at the same time. Change one of the times.",
            slotsBlocker(listOf(overnightSlot("21:00"), overnightSlot("21:00", 2)), timing),
        )
    }
    @Test
    fun `anchorOpenBlockVisit leaves a start-time visit alone, even one already started`() {
        val v = buildVisits(listOf(sep4), listOf(overnightSlot("11:30")), catalog, utc, timing).single()
        // 12:00, inside Midday: a Midday visit would be moved; this one carries no window.
        val now = msAt(2026, 9, 4, 12)
        assertSame(v, anchorOpenBlockVisit(v, timing.blocks, now, utc))
        assertEquals(1, pastPlannedVisits(listOf(v), now).size)
    }
    @Test
    fun `renders a start-time visit by its clock time on Review`() {
        val visits = buildVisits(listOf(sep4), listOf(overnightSlot("21:00")), catalog, utc, timing)
        val rendered = renderPlannedVisits(visits, utc, listOf(midday, evening)).single()
        assertNull(rendered.timeBlockLabel)
        assertEquals("Fri, Sep 4 at 9:00 PM", plannedVisitLine(rendered))
    }
}
