package com.tribetails.auntieos.web.screens.home

import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.screens.inbox.ConversationSummary
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A8 dashboard insight widgets: pure logic for Weekly capacity (W8), Overdue
 * visits (W9), Pets by type (W10), Frequent flyers (W11) and Holiday runway (W13).
 * Mirrors the HouseholdVisitGapsTest conventions: plain data in, plain data out.
 */
class DashboardInsightsTest {

    private fun visit(date: String, status: String = "SCHEDULED", kinId: String = "a", name: String = "the Bs") =
        KinCareSession(kinfolkId = kinId, kinfolkName = name, startTime = date, status = status)

    // ── W8 weekly capacity ────────────────────────────────────────────────────

    @Test
    fun `capacity counts this week's visits against the busiest of the last 4 weeks`() {
        // Today 2026-06-24 (Wed); this week = Mon 2026-06-22..Sun 2026-06-28.
        val sessions =
            listOf("2026-06-22", "2026-06-23", "2026-06-25").map { visit(it) } +          // 3 this week
            listOf("2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19")  // 5 last week
                .map { visit(it, status = "COMPLETED") } +
            listOf("2026-06-08", "2026-06-09").map { visit(it, status = "COMPLETED") }     // 2 two weeks back
        val cap = weeklyCapacity(sessions, "2026-06-24")!!
        assertEquals(3, cap.booked)
        assertEquals(5, cap.capacity)
        assertEquals(3f / 5f, cap.fraction)
    }

    @Test
    fun `cancelled visits never count and a record week caps the bar at full`() {
        val sessions =
            listOf("2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25").map { visit(it) } +
            listOf(visit("2026-06-23", status = "CANCELLED")) +
            listOf("2026-06-15", "2026-06-16").map { visit(it, status = "COMPLETED") }
        val cap = weeklyCapacity(sessions, "2026-06-24")!!
        assertEquals(4, cap.booked)
        assertEquals(2, cap.record)          // busiest prior week
        assertEquals(4, cap.capacity)        // floored at booked so the bar tops out at 1
        assertEquals(1f, cap.fraction)
        assertTrue(cap.beatingRecord)
    }

    @Test
    fun `no history means capacity floors at 1 and bad today returns null`() {
        val cap = weeklyCapacity(emptyList(), "2026-06-24")!!
        assertEquals(0, cap.booked)
        assertEquals(1, cap.capacity)
        assertEquals(0f, cap.fraction)
        assertNull(weeklyCapacity(emptyList(), "not-a-date"))
    }

    // ── W9 overdue visits ─────────────────────────────────────────────────────

    @Test
    fun `flags visits whose end time passed without COMPLETED, most overdue-recent first`() {
        val now = "2026-06-24T12:00:00"
        val sessions = listOf(
            KinCareSession(_id = "s1", kinfolkName = "the Bs", startTime = "2026-06-24T08:00:00",
                endTime = "2026-06-24T09:00:00", status = "ARRIVED"),
            KinCareSession(_id = "s2", kinfolkName = "the Cs", startTime = "2026-06-23T10:00:00",
                endTime = "2026-06-23T11:00:00", status = "DEPARTED"),
            KinCareSession(_id = "s3", kinfolkName = "the Ds", startTime = "2026-06-24T08:00:00",
                endTime = "2026-06-24T09:00:00", status = "COMPLETED"),   // done: not overdue
            KinCareSession(_id = "s4", kinfolkName = "the Es", startTime = "2026-06-24T14:00:00",
                endTime = "2026-06-24T15:00:00", status = "SCHEDULED"),   // future: not overdue
        )
        val overdue = overdueVisits(sessions, now)
        assertEquals(listOf("s1", "s2"), overdue.map { it.sessionId })
        assertEquals("the Bs", overdue[0].kinfolkName)
    }

    @Test
    fun `falls back to startTime when endTime is blank and skips cancelled + stale junk`() {
        val now = "2026-06-24T12:00:00"
        val sessions = listOf(
            KinCareSession(_id = "s1", kinfolkName = "the Bs", startTime = "2026-06-24T08:00:00", status = "ON_MY_WAY"),
            KinCareSession(_id = "s2", kinfolkName = "the Cs", startTime = "2026-06-23T08:00:00", status = "CANCELLED"),
            // ancient never-completed row: outside the 30-day actionable window
            KinCareSession(_id = "s3", kinfolkName = "the Ds", startTime = "2025-01-01T08:00:00", status = "SCHEDULED"),
        )
        assertEquals(listOf("s1"), overdueVisits(sessions, now).map { it.sessionId })
    }

    // ── W10 pets by type ──────────────────────────────────────────────────────

    @Test
    fun `groups active kin by normalized species, biggest slice first`() {
        val kin = listOf(
            Kin(name = "Rex", species = "dog"),
            Kin(name = "Fido", species = "Dog"),
            Kin(name = "Tom", species = "CAT"),
            Kin(name = "Old Yeller", species = "Dog", status = "archived"),  // dropped
            Kin(name = "Mystery", species = "  "),
        )
        val slices = speciesBreakdown(kin)
        assertEquals(listOf("Dog" to 2, "Cat" to 1, "Unknown" to 1), slices.map { it.species to it.count })
        assertEquals(4, slices.sumOf { it.count })
    }

    // ── W11 frequent flyers ───────────────────────────────────────────────────

    @Test
    fun `ranks households by completed visits in the trailing 90 days`() {
        val sessions =
            (1..4).map { visit("2026-06-0$it", status = "COMPLETED", kinId = "a", name = "the Bs") } +
            (1..2).map { visit("2026-06-1$it", status = "COMPLETED", kinId = "b", name = "the Cs") } +
            listOf(
                visit("2026-06-20", status = "SCHEDULED", kinId = "b", name = "the Cs"),  // not completed
                visit("2025-06-01", status = "COMPLETED", kinId = "c", name = "the Ds"),  // outside 90d
            )
        val flyers = frequentFlyers(sessions, "2026-06-24")
        assertEquals(listOf("the Bs" to 4, "the Cs" to 2), flyers.map { it.household to it.visits })
    }

    @Test
    fun `frequent flyers respects the limit`() {
        val sessions = (1..8).map { visit("2026-06-1$it".take(10), status = "COMPLETED", kinId = "k$it", name = "fam$it") }
        assertEquals(3, frequentFlyers(sessions, "2026-06-24", limit = 3).size)
    }

    // ── W13 holiday runway ────────────────────────────────────────────────────

    @Test
    fun `computes the standard US pet-care holiday dates for 2026`() {
        val dates = usPetCareHolidays(2026).associate { it.name to it.date.toString() }
        assertEquals("2026-01-01", dates["New Year's Day"])
        assertEquals("2026-05-25", dates["Memorial Day"])       // last Monday of May
        assertEquals("2026-07-04", dates["July 4th"])
        assertEquals("2026-09-07", dates["Labor Day"])          // first Monday of September
        assertEquals("2026-11-26", dates["Thanksgiving"])       // fourth Thursday of November
        assertEquals("2026-12-25", dates["Christmas"])
    }

    @Test
    fun `runway lists the next 3 holidays with countdown and booked visits in the +-2 day window`() {
        val sessions = listOf(
            visit("2026-07-03"), visit("2026-07-04"), visit("2026-07-06"),  // all inside July 4 +-2
            visit("2026-07-08"),                                            // outside the window
            visit("2026-07-05", status = "CANCELLED"),                      // cancelled: not booked
            visit("2026-09-06"),                                            // Labor Day window
        )
        val runway = holidayRunway(sessions, "2026-07-02")
        assertEquals(listOf("July 4th", "Labor Day", "Thanksgiving"), runway.map { it.name })
        assertEquals(2, runway[0].daysUntil)
        assertEquals(3, runway[0].bookedVisits)
        assertEquals(1, runway[1].bookedVisits)
        assertEquals(0, runway[2].bookedVisits)
    }

    @Test
    fun `runway rolls into next year and counts a today holiday as 0 days`() {
        val runway = holidayRunway(emptyList(), "2026-12-25")
        assertEquals(listOf("Christmas", "New Year's Day"), runway.take(2).map { it.name })
        assertEquals(0, runway[0].daysUntil)
        assertEquals("2027-01-01", runway[1].dateIso)
        assertEquals(7, runway[1].daysUntil)
    }

    // ── AO-38 / W6 unread client messages ──────────────────────────────────────

    private fun conv(
        id: String = "k1",
        name: String = "Rivera",
        preview: String = "Hi Auntie",
        atMs: Long = 1_000,
        unread: Boolean = true,
    ) = ConversationSummary(
        kinfolkId = id,
        kinfolkName = name,
        lastMessagePreview = preview,
        lastMessageAtMs = atMs,
        lastSenderRole = "kinfolk",
        unreadForAdmin = unread,
        messageCount = 2,
    )

    @Test
    fun `unread keeps only unread threads, newest first`() {
        val rows = listOf(
            conv(id = "a", atMs = 100, unread = true),
            conv(id = "b", atMs = 300, unread = true),
            conv(id = "c", atMs = 200, unread = false),
        )
        assertEquals(listOf("b", "a"), unreadClientMessages(rows).map { it.kinfolkId })
    }

    @Test
    fun `unread caps display but the count is the full unread total`() {
        val rows = (0 until 8).map { conv(id = "k$it", atMs = it.toLong(), unread = true) }
        assertEquals(3, unreadClientMessages(rows, limit = 3).size)
        assertEquals(8, unreadClientMessageCount(rows))
    }

    @Test
    fun `unread falls back to id for a blank name and trims a blank preview`() {
        val row = unreadClientMessages(listOf(conv(id = "k9", name = "   ", preview = "  "))).first()
        assertEquals("k9", row.household)
        assertEquals("", row.preview)
    }

    @Test
    fun `unread count is zero for an all-read list`() {
        assertEquals(0, unreadClientMessageCount(listOf(conv(unread = false), conv(unread = false))))
    }
}
