package com.kinfolk.portal.screens.schedule
import com.kinfolk.portal.portal.BookingMode
import com.kinfolk.portal.portal.BookingVisit
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
 * #1098 (replacing #1092's start-time picker): a KinCare in
 * `startTimeServiceIds` is asked for by NIGHT only. The operator sets its start
 * time when approving, because she may have evening visits to finish first. So
 * the slot has no clock and no window in either plan mode, and the visit goes
 * out with a `date` and no `startTimeMs`.
 *
 * The web mirror is the "night-only KinCares (#1098)" section of
 * mytribe/web/src/lib/bookingWizardLogic.test.ts; both assert the same facts
 * about the same functions.
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
    private val clockTiming = BookingTiming(BookingMode.SpecificTime, emptyList(), setOf("Overnight"))
    private val sep4 = LocalDate(2026, 9, 4) // a Friday
    private fun msAt(y: Int, m: Int, d: Int, hour: Int, minute: Int = 0): Long =
        LocalDateTime(y, m, d, hour, minute).toInstant(utc).toEpochMilliseconds()
    /** A KinCare in a named window. Its `time` is junk: a window slot must never read it. */
    private fun blockSlot(serviceId: String, blockId: String?, n: Int = 1) =
        KinCareSlot(slotId = "$serviceId-$blockId-$n", serviceId = serviceId, time = "nonsense", timeBlockId = blockId)
    private fun clockSlot(serviceId: String, time: String, n: Int = 1) =
        KinCareSlot(slotId = "$serviceId-$time-$n", serviceId = serviceId, time = time, timeBlockId = null)
    /**
     * An overnight carrying BOTH a real window id and a clock time, so a mistake
     * that reads either, or sends either, cannot pass by accident.
     */
    private fun overnightSlot(n: Int = 1) =
        KinCareSlot(slotId = "Overnight-$n", serviceId = "Overnight", time = "21:00", timeBlockId = "midday")

    @Test
    fun `decides the kind per slot, night-only for a flagged KinCare in either plan mode`() {
        assertTrue(serviceIsNightOnly("Overnight", timing))
        assertFalse(serviceIsNightOnly("30Minute", timing))
        assertEquals(SlotMode.NightOnly, slotMode(overnightSlot(), timing))
        assertEquals(SlotMode.NightOnly, slotMode(overnightSlot(), clockTiming))
        assertEquals(SlotMode.TimeBlock, slotMode(blockSlot("30Minute", "midday"), timing))
        assertEquals(SlotMode.SpecificTime, slotMode(clockSlot("30Minute", "09:00"), clockTiming))
    }

    @Test
    fun `a timing without the list (an older server) treats nothing as night-only`() {
        assertFalse(serviceIsNightOnly("Overnight", blockTiming))
        val v = buildVisits(listOf(sep4), listOf(overnightSlot()), catalog, utc, blockTiming).single()
        assertEquals("midday", v.timeBlockId)
        assertEquals(msAt(2026, 9, 4, 11), v.startTimeMs)
        assertNull(v.date)
    }

    @Test
    fun `sends the night as a date with no start and no window, beside a window visit that keeps its window`() {
        val visits = buildVisits(
            listOf(sep4),
            listOf(overnightSlot(), blockSlot("30Minute", "midday")),
            catalog,
            utc,
            timing,
        )
        assertEquals(2, visits.size)
        val (mid, night) = visits
        assertEquals("30Minute", mid.serviceId)
        assertEquals("midday", mid.timeBlockId)
        assertEquals(msAt(2026, 9, 4, 11), mid.startTimeMs)
        assertEquals(
            BookingVisit(
                startTimeMs = null,
                endTimeMs = null,
                serviceId = "Overnight",
                serviceName = "Overnight",
                priceCents = 15000,
                timeBlockId = null,
                date = "2026-09-04",
            ),
            night,
        )
    }

    @Test
    fun `sends a date in a specific-time plan too`() {
        val visits = buildVisits(listOf(sep4), listOf(clockSlot("30Minute", "22:00"), overnightSlot()), catalog, utc, clockTiming)
        assertEquals(
            listOf(
                Triple("30Minute", msAt(2026, 9, 4, 22), null),
                Triple("Overnight", null, "2026-09-04"),
            ),
            visits.map { Triple(it.serviceId, it.startTimeMs, it.date) },
        )
    }

    @Test
    fun `sorts a night after every timed visit on its own day and before the next day`() {
        val visits = buildVisits(
            listOf(LocalDate(2026, 9, 5), sep4),
            listOf(overnightSlot(), clockSlot("30Minute", "23:30")),
            catalog,
            utc,
            clockTiming,
        )
        assertEquals(
            listOf(
                "30Minute" to "2026-09-04",
                "Overnight" to "2026-09-04",
                "30Minute" to "2026-09-05",
                "Overnight" to "2026-09-05",
            ),
            visits.map { it.serviceId to plannedVisitDayKey(it, utc) },
        )
    }

    @Test
    fun `expands a weekly rule with one night per chosen day, including tonight, after the timed visit`() {
        val visits = buildWeeklyVisits(
            nowMs = msAt(2026, 9, 4, 22), // a Friday, late
            weeklyDays = setOf(5),
            weeks = 2,
            slots = listOf(overnightSlot(), blockSlot("30Minute", "evening")),
            services = catalog,
            tz = utc,
            timing = timing,
        )
        // Tonight's Evening window has closed, so only next Friday's is sent; both nights are.
        assertEquals(
            listOf(
                Triple("Overnight", null, "2026-09-04"),
                Triple("30Minute", "evening", null),
                Triple("Overnight", null, "2026-09-11"),
            ),
            visits.map { Triple(it.serviceId, it.timeBlockId, it.date) },
        )
        assertTrue(visits.filter { it.serviceId == "Overnight" }.all { it.startTimeMs == null })
    }

    @Test
    fun `asks a night-only KinCare for nothing and still asks the others for theirs`() {
        val bare = KinCareSlot("o", "Overnight", "", null)
        assertNull(slotsBlocker(listOf(bare, blockSlot("30Minute", "midday")), timing))
        assertNull(slotsBlocker(listOf(bare), clockTiming))
        assertEquals(
            "Choose a time block for every KinCare.",
            slotsBlocker(listOf(overnightSlot(), blockSlot("30Minute", null)), timing),
        )
        assertEquals(
            "Enter every KinCare time as HH:MM.",
            slotsBlocker(listOf(overnightSlot(), clockSlot("30Minute", "")), clockTiming),
        )
        assertNull(weeklyVisitsBlocker(setOf(5), 2, listOf(bare), timing))
    }

    @Test
    fun `refuses the same night-only KinCare twice in one plan whatever its stale time or window says`() {
        val a = overnightSlot(1)
        val b = overnightSlot(2).copy(time = "07:00", timeBlockId = "evening")
        val msg = "That KinCare is on the plan twice for the same night. Remove one."
        assertEquals(msg, slotsBlocker(listOf(a, b), timing))
        assertEquals(msg, slotsBlocker(listOf(a, b), clockTiming))
    }

    @Test
    fun `anchorOpenBlockVisit leaves a night alone`() {
        val v = buildVisits(listOf(sep4), listOf(overnightSlot()), catalog, utc, timing).single()
        val now = msAt(2026, 9, 4, 12)
        assertSame(v, anchorOpenBlockVisit(v, timing.blocks, now, utc))
        assertEquals(listOf(v), anchorOpenBlockVisits(listOf(v), timing.blocks, now, utc))
    }

    @Test
    fun `a night is past only once its date is before today`() {
        val v = buildVisits(listOf(sep4), listOf(overnightSlot()), catalog, utc, timing).single()
        assertTrue(pastPlannedVisits(listOf(v), msAt(2026, 9, 4, 23, 59), utc).isEmpty())
        assertEquals(1, pastPlannedVisits(listOf(v), msAt(2026, 9, 5, 0, 1), utc).size)
    }

    @Test
    fun `renders a night on Review with its own day and no clock`() {
        val visits = buildVisits(
            listOf(LocalDate(2026, 10, 9)),
            listOf(overnightSlot(), blockSlot("30Minute", "midday")),
            catalog,
            utc,
            timing,
        )
        val rendered = renderPlannedVisits(visits, utc, listOf(midday, evening))
        assertEquals(
            listOf("Fri, Oct 9, Midday (11:00-15:00)", "Fri, Oct 9, start time set by your Auntie"),
            rendered.map { plannedVisitLine(it) },
        )
        assertEquals("Overnight", rendered[1].serviceName)
        assertEquals(2, rendered.map { it.key }.toSet().size)
    }

    @Test
    fun `prices a night like any other visit`() {
        val visits = buildVisits(listOf(sep4, LocalDate(2026, 9, 5)), listOf(overnightSlot()), catalog, utc, timing)
        assertEquals(30000L, estimateBookingTotal(visits, catalog).totalCents)
    }
}
