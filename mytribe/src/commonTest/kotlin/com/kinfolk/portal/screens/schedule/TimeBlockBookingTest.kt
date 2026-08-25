package com.kinfolk.portal.screens.schedule

import com.kinfolk.portal.portal.BookingMode
import com.kinfolk.portal.portal.BookingPolicy
import com.kinfolk.portal.portal.Service
import com.kinfolk.portal.portal.TimeBlock
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Time-block booking, portal Android half. Operator requirement 2026-08-24:
 * "kinfolk book within time blocks, not at a specific set time. I need to be
 * able to create these time blocks and those are what the kinfolk should be
 * able to select from when booking."
 *
 * The web mirror is the time-block section of
 * mytribe/web/src/lib/bookingWizardLogic.test.ts, and these assert the same
 * facts about the same functions so the two clients cannot drift: a visit's
 * start comes from its window (never from the clock field, which block mode
 * must not read at all), and the duplicate rule counts a visit as
 * (KinCare, block) rather than (KinCare, instant).
 */
class TimeBlockBookingTest {

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
    private val sixtyMinute = service("60Minute", "60 Minute", 4500)
    private val catalog = listOf(thirtyMinute, sixtyMinute)

    private val midday = TimeBlock("midday", "Midday", "11:00", "15:00", 240)
    private val evening = TimeBlock("evening", "Evening", "17:00", "21:00", 240)
    private val blockTiming = BookingTiming(BookingMode.TimeBlock, listOf(midday, evening))

    /** A KinCare in a named window. Its `time` is deliberately junk: block mode must never read it. */
    private fun blockSlot(serviceId: String, blockId: String, n: Int = 1) =
        KinCareSlot(slotId = "$serviceId-$blockId-$n", serviceId = serviceId, time = "nonsense", timeBlockId = blockId)

    private fun clockSlot(serviceId: String, time: String, n: Int = 1) =
        KinCareSlot(slotId = "$serviceId-$n", serviceId = serviceId, time = time)

    private fun policy(
        blocks: Boolean,
        specific: Boolean,
        default: BookingMode,
    ) = BookingPolicy(blocks, specific, default, if (blocks) listOf(midday, evening) else emptyList())

    private fun msAt(y: Int, m: Int, d: Int, hour: Int, minute: Int = 0): Long =
        LocalDateTime(y, m, d, hour, minute).toInstant(utc).toEpochMilliseconds()

    // ── mode resolution ──────────────────────────────────────────────────────

    @Test
    fun `opens on the business default when both modes are allowed`() {
        assertEquals(BookingMode.TimeBlock, initialBookingMode(policy(true, true, BookingMode.TimeBlock)))
        assertEquals(BookingMode.SpecificTime, initialBookingMode(policy(true, true, BookingMode.SpecificTime)))
    }

    @Test
    fun `opens on the only allowed mode whatever the stored default says`() {
        assertEquals(BookingMode.TimeBlock, initialBookingMode(policy(true, false, BookingMode.SpecificTime)))
        assertEquals(BookingMode.SpecificTime, initialBookingMode(policy(false, true, BookingMode.TimeBlock)))
    }

    @Test
    fun `the clock-only fallback is a usable policy, not an empty screen`() {
        assertEquals(BookingMode.SpecificTime, initialBookingMode(BookingPolicy.CLOCK_ONLY))
        assertTrue(BookingPolicy.CLOCK_ONLY.allowSpecificTimeBooking)
        assertTrue(BookingPolicy.CLOCK_ONLY.timeBlocks.isEmpty())
    }

    @Test
    fun `a window is named with its hours`() {
        assertEquals("Midday (11:00-15:00)", timeBlockLabel(midday))
        assertEquals(evening, findTimeBlock(listOf(midday, evening), "evening"))
        assertNull(findTimeBlock(listOf(midday, evening), "brunch"))
        assertNull(findTimeBlock(listOf(midday, evening), null))
    }

    // ── the blocker, in block words ──────────────────────────────────────────

    @Test
    fun `asks for a window when a KinCare has none, or names one that is gone`() {
        assertEquals(
            "Choose a time block for every KinCare.",
            slotsBlocker(listOf(clockSlot("30Minute", "09:00")), blockTiming),
        )
        assertEquals(
            "Choose a time block for every KinCare.",
            slotsBlocker(listOf(blockSlot("30Minute", "brunch")), blockTiming),
        )
    }

    @Test
    fun `accepts two different durations in the same window`() {
        assertNull(slotsBlocker(listOf(blockSlot("30Minute", "midday"), blockSlot("60Minute", "midday")), blockTiming))
    }

    @Test
    fun `accepts the same duration in two different windows`() {
        assertNull(slotsBlocker(listOf(blockSlot("30Minute", "midday"), blockSlot("30Minute", "evening")), blockTiming))
    }

    @Test
    fun `refuses the same duration in the same window twice`() {
        assertEquals(
            "Two KinCares are the same duration in the same time block. Remove one, or move it to another block.",
            slotsBlocker(listOf(blockSlot("30Minute", "midday"), blockSlot("30Minute", "midday", 2)), blockTiming),
        )
    }

    @Test
    fun `never reads the clock field in block mode`() {
        // The same slot, whose `time` is junk: sendable as a block, refused as a clock.
        assertNull(slotsBlocker(listOf(blockSlot("30Minute", "midday")), blockTiming))
        assertEquals("Enter every KinCare time as HH:MM.", slotsBlocker(listOf(blockSlot("30Minute", "midday"))))
    }

    // ── visit building ───────────────────────────────────────────────────────

    @Test
    fun `starts each visit at its window and stamps the block id on it`() {
        val visits = buildVisits(listOf(LocalDate(2026, 9, 4)), listOf(blockSlot("30Minute", "midday")), catalog, utc, blockTiming)
        assertEquals(1, visits.size)
        assertEquals(msAt(2026, 9, 4, 11), visits[0].startTimeMs)
        assertEquals("midday", visits[0].timeBlockId)
    }

    @Test
    fun `prices a block-booked visit from the KinCare, exactly as a clock-booked one`() {
        val block = buildVisits(listOf(LocalDate(2026, 9, 4)), listOf(blockSlot("30Minute", "midday")), catalog, utc, blockTiming)
        val clock = buildVisits(listOf(LocalDate(2026, 9, 4)), listOf(clockSlot("30Minute", "11:00")), catalog, utc)
        assertEquals(2500L, block[0].priceCents)
        assertEquals(clock[0].priceCents, block[0].priceCents)
        assertEquals(estimateBookingTotal(clock, catalog), estimateBookingTotal(block, catalog))
    }

    @Test
    fun `emits two visits for two durations in one window, both at the same instant`() {
        val visits = buildVisits(
            listOf(LocalDate(2026, 9, 4)),
            listOf(blockSlot("30Minute", "midday"), blockSlot("60Minute", "midday")),
            catalog,
            utc,
            blockTiming,
        )
        assertEquals(2, visits.size)
        assertEquals(1, visits.map { it.startTimeMs }.toSet().size)
        assertEquals(listOf("30Minute", "60Minute"), visits.map { it.serviceId })
    }

    /**
     * #597, client half. The server used to key a block-mode visit as
     * (KinCare, block) with no date and refuse this as one visit asked for three
     * times. The wizard was never wrong — `slotsBlocker` reads ONE day's KinCare
     * list and `buildVisits` multiplies it by the dates — and this pins that, so
     * the client half of the (date, KinCare, block) identity cannot drift into
     * agreeing with the bug.
     */
    @Test
    fun `sends the same KinCare in the same window on every chosen date, not one duplicate`() {
        val slots = listOf(blockSlot("30Minute", "midday"))
        assertNull(slotsBlocker(slots, blockTiming))
        val visits = buildVisits(
            listOf(LocalDate(2026, 9, 4), LocalDate(2026, 9, 5), LocalDate(2026, 9, 6)),
            slots,
            catalog,
            utc,
            blockTiming,
        )
        assertEquals(3, visits.size)
        assertTrue(visits.all { it.timeBlockId == "midday" })
        // Three distinct instants, one per date, all on the window's first minute.
        assertEquals(3, visits.map { it.startTimeMs }.toSet().size)
        assertEquals(
            listOf(msAt(2026, 9, 4, 11), msAt(2026, 9, 5, 11), msAt(2026, 9, 6, 11)),
            visits.map { it.startTimeMs },
        )
    }

    @Test
    fun `drops a KinCare whose window is gone rather than inventing a time for it`() {
        assertTrue(
            buildVisits(listOf(LocalDate(2026, 9, 4)), listOf(blockSlot("30Minute", "brunch")), catalog, utc, blockTiming)
                .isEmpty(),
        )
    }

    @Test
    fun `leaves timeBlockId null on every clock-booked visit`() {
        val visits = buildVisits(listOf(LocalDate(2026, 9, 4)), listOf(clockSlot("30Minute", "09:00")), catalog, utc)
        assertNull(visits[0].timeBlockId)
    }

    @Test
    fun `expands a weekly rule onto the window start, block id intact`() {
        // Friday 2026-09-04 at 08:00 UTC, so the same day's 11:00 window is ahead.
        val visits = buildWeeklyVisits(
            nowMs = msAt(2026, 9, 4, 8),
            weeklyDays = setOf(5),
            weeks = 2,
            slots = listOf(blockSlot("30Minute", "midday")),
            services = catalog,
            tz = utc,
            timing = blockTiming,
        )
        assertEquals(2, visits.size)
        assertTrue(visits.all { it.timeBlockId == "midday" })
        assertEquals(msAt(2026, 9, 4, 11), visits[0].startTimeMs)
    }

    @Test
    fun `still drops a weekly occurrence whose window has already opened today`() {
        val visits = buildWeeklyVisits(
            nowMs = msAt(2026, 9, 4, 14),
            weeklyDays = setOf(5),
            weeks = 2,
            slots = listOf(blockSlot("30Minute", "midday")),
            services = catalog,
            tz = utc,
            timing = blockTiming,
        )
        assertEquals(1, visits.size)
        assertEquals(msAt(2026, 9, 11, 11), visits[0].startTimeMs)
    }

    // ── the past-visit gate ──────────────────────────────────────────────────

    @Test
    fun `names the visits the server would refuse for starting in the past`() {
        val visits = buildVisits(
            listOf(LocalDate(2026, 9, 4)),
            listOf(blockSlot("30Minute", "midday"), blockSlot("60Minute", "evening")),
            catalog,
            utc,
            blockTiming,
        )
        // Midday opened at 11:00 and it is 14:00; Evening opens at 17:00.
        val past = pastPlannedVisits(visits, msAt(2026, 9, 4, 14))
        assertEquals(1, past.size)
        assertEquals("midday", past[0].timeBlockId)
    }

    @Test
    fun `is empty for a plan entirely in the future`() {
        val visits = buildVisits(listOf(LocalDate(2026, 9, 4)), listOf(blockSlot("30Minute", "midday")), catalog, utc, blockTiming)
        assertTrue(pastPlannedVisits(visits, msAt(2026, 9, 4, 8)).isEmpty())
    }

    // ── how a booked window reads back ───────────────────────────────────────

    @Test
    fun `names the window instead of reporting a precision the household never gave`() {
        val visits = buildVisits(listOf(LocalDate(2026, 9, 4)), listOf(blockSlot("30Minute", "midday")), catalog, utc, blockTiming)
        val rendered = renderPlannedVisits(visits, utc, listOf(midday, evening))
        assertEquals("Midday (11:00-15:00)", rendered[0].timeBlockLabel)
        assertEquals("Fri, Sep 4, Midday (11:00-15:00)", plannedVisitLine(rendered[0]))
    }

    @Test
    fun `still spells a clock-booked visit the way the spec does`() {
        val visits = buildVisits(listOf(LocalDate(2026, 9, 4)), listOf(clockSlot("30Minute", "09:00")), catalog, utc)
        val rendered = renderPlannedVisits(visits, utc, listOf(midday, evening))
        assertNull(rendered[0].timeBlockLabel)
        assertEquals("Fri, Sep 4 at 9:00 AM", plannedVisitLine(rendered[0]))
    }

    @Test
    fun `gives two durations in one window distinct keys, though their instants are equal`() {
        val visits = buildVisits(
            listOf(LocalDate(2026, 9, 4)),
            listOf(blockSlot("30Minute", "midday"), blockSlot("60Minute", "midday")),
            catalog,
            utc,
            blockTiming,
        )
        assertEquals(2, renderPlannedVisits(visits, utc, listOf(midday)).map { it.key }.toSet().size)
    }
}
