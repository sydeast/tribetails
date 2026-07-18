package com.tribetails.auntieos.ui.home

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.inbox.ConversationSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AO-24: android parity for the A8 insight compute logic. Mirror of the web
 * DashboardInsightsTest — same cases, android models + JUnit4.
 */
class DashboardInsightsTest {

    private fun visit(date: String, status: String = "SCHEDULED", kinId: String = "a", name: String = "the Bs") =
        KinCareSession(kinfolkId = kinId, kinfolkName = name, startTime = date, status = status)

    // ── Weekly capacity ─────────────────────────────────────────────────────

    @Test
    fun capacity_counts_this_week_against_busiest_of_last_4_weeks() {
        val sessions =
            listOf("2026-06-22", "2026-06-23", "2026-06-25").map { visit(it) } +
            listOf("2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19")
                .map { visit(it, status = "COMPLETED") } +
            listOf("2026-06-08", "2026-06-09").map { visit(it, status = "COMPLETED") }
        val cap = weeklyCapacity(sessions, "2026-06-24")!!
        assertEquals(3, cap.booked)
        assertEquals(5, cap.capacity)
        assertEquals(3f / 5f, cap.fraction, 1e-4f)
    }

    @Test
    fun cancelled_never_count_and_a_record_week_caps_the_bar_at_full() {
        val sessions =
            listOf("2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25").map { visit(it) } +
            listOf(visit("2026-06-23", status = "CANCELLED")) +
            listOf("2026-06-15", "2026-06-16").map { visit(it, status = "COMPLETED") }
        val cap = weeklyCapacity(sessions, "2026-06-24")!!
        assertEquals(4, cap.booked)
        assertEquals(2, cap.record)
        assertEquals(4, cap.capacity)
        assertEquals(1f, cap.fraction, 1e-4f)
        assertTrue(cap.beatingRecord)
    }

    @Test
    fun no_history_floors_capacity_at_1_and_bad_today_returns_null() {
        val cap = weeklyCapacity(emptyList(), "2026-06-24")!!
        assertEquals(0, cap.booked)
        assertEquals(1, cap.capacity)
        assertEquals(0f, cap.fraction, 1e-4f)
        assertNull(weeklyCapacity(emptyList(), "not-a-date"))
    }

    // ── Overdue visits ──────────────────────────────────────────────────────

    @Test
    fun flags_visits_past_end_without_completed_most_recent_first() {
        val now = "2026-06-24T12:00:00"
        val sessions = listOf(
            KinCareSession(id = "s1", kinfolkName = "the Bs", startTime = "2026-06-24T08:00:00",
                endTime = "2026-06-24T09:00:00", status = "ARRIVED"),
            KinCareSession(id = "s2", kinfolkName = "the Cs", startTime = "2026-06-23T10:00:00",
                endTime = "2026-06-23T11:00:00", status = "DEPARTED"),
            KinCareSession(id = "s3", kinfolkName = "the Ds", startTime = "2026-06-24T08:00:00",
                endTime = "2026-06-24T09:00:00", status = "COMPLETED"),
            KinCareSession(id = "s4", kinfolkName = "the Es", startTime = "2026-06-24T14:00:00",
                endTime = "2026-06-24T15:00:00", status = "SCHEDULED"),
        )
        val overdue = overdueVisits(sessions, now)
        assertEquals(listOf("s1", "s2"), overdue.map { it.sessionId })
        assertEquals("the Bs", overdue[0].kinfolkName)
    }

    @Test
    fun falls_back_to_start_when_end_blank_and_skips_cancelled_and_stale() {
        val now = "2026-06-24T12:00:00"
        val sessions = listOf(
            KinCareSession(id = "s1", kinfolkName = "the Bs", startTime = "2026-06-24T08:00:00", status = "ON_MY_WAY"),
            KinCareSession(id = "s2", kinfolkName = "the Cs", startTime = "2026-06-23T08:00:00", status = "CANCELLED"),
            KinCareSession(id = "s3", kinfolkName = "the Ds", startTime = "2025-01-01T08:00:00", status = "SCHEDULED"),
        )
        assertEquals(listOf("s1"), overdueVisits(sessions, now).map { it.sessionId })
    }

    // ── Pets by type ────────────────────────────────────────────────────────

    @Test
    fun groups_active_kin_by_normalized_species_biggest_first() {
        val kin = listOf(
            Kin(name = "Rex", species = "dog"),
            Kin(name = "Fido", species = "Dog"),
            Kin(name = "Tom", species = "CAT"),
            Kin(name = "Old Yeller", species = "Dog", status = "archived"),
            Kin(name = "Mystery", species = "  "),
        )
        val slices = speciesBreakdown(kin)
        assertEquals(listOf("Dog" to 2, "Cat" to 1, "Unknown" to 1), slices.map { it.species to it.count })
        assertEquals(4, slices.sumOf { it.count })
    }

    // ── Frequent flyers ─────────────────────────────────────────────────────

    @Test
    fun ranks_households_by_completed_visits_in_trailing_90_days() {
        val sessions =
            (1..4).map { visit("2026-06-0$it", status = "COMPLETED", kinId = "a", name = "the Bs") } +
            (1..2).map { visit("2026-06-1$it", status = "COMPLETED", kinId = "b", name = "the Cs") } +
            listOf(
                visit("2026-06-20", status = "SCHEDULED", kinId = "b", name = "the Cs"),
                visit("2025-06-01", status = "COMPLETED", kinId = "c", name = "the Ds"),
            )
        val flyers = frequentFlyers(sessions, "2026-06-24")
        assertEquals(listOf("the Bs" to 4, "the Cs" to 2), flyers.map { it.household to it.visits })
    }

    @Test
    fun frequent_flyers_respects_the_limit() {
        val sessions = (1..8).map { visit("2026-06-1$it".take(10), status = "COMPLETED", kinId = "k$it", name = "fam$it") }
        assertEquals(3, frequentFlyers(sessions, "2026-06-24", limit = 3).size)
    }

    // ── Holiday runway ──────────────────────────────────────────────────────

    @Test
    fun computes_the_standard_us_pet_care_holiday_dates_for_2026() {
        val dates = usPetCareHolidays(2026).associate { it.name to it.date.toString() }
        assertEquals("2026-01-01", dates["New Year's Day"])
        assertEquals("2026-05-25", dates["Memorial Day"])
        assertEquals("2026-07-04", dates["July 4th"])
        assertEquals("2026-09-07", dates["Labor Day"])
        assertEquals("2026-11-26", dates["Thanksgiving"])
        assertEquals("2026-12-25", dates["Christmas"])
    }

    @Test
    fun runway_lists_next_3_holidays_with_countdown_and_booked_in_window() {
        val sessions = listOf(
            visit("2026-07-03"), visit("2026-07-04"), visit("2026-07-06"),
            visit("2026-07-08"),
            visit("2026-07-05", status = "CANCELLED"),
            visit("2026-09-06"),
        )
        val runway = holidayRunway(sessions, "2026-07-02")
        assertEquals(listOf("July 4th", "Labor Day", "Thanksgiving"), runway.map { it.name })
        assertEquals(2, runway[0].daysUntil)
        assertEquals(3, runway[0].bookedVisits)
        assertEquals(1, runway[1].bookedVisits)
        assertEquals(0, runway[2].bookedVisits)
    }

    @Test
    fun runway_rolls_into_next_year_and_counts_a_today_holiday_as_0() {
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
    fun `unread caps display but count is the full unread total`() {
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

    // ── AO-36 / W3 key & code safebox ───────────────────────────────────────────

    @Test
    fun `next upcoming picks the earliest future non-cancelled non-completed visit`() {
        val sessions = listOf(
            visit("2026-07-21T09:00:00Z", kinId = "a"),
            visit("2026-07-20T08:00:00Z", kinId = "b"),
            visit("2026-07-18T09:00:00Z", kinId = "c"),
        )
        assertEquals("b", nextUpcomingSession(sessions, "2026-07-19T12:00:00Z")?.kinfolkId)
    }

    @Test
    fun `next upcoming skips cancelled and completed even when soonest`() {
        val sessions = listOf(
            visit("2026-07-20T07:00:00Z", status = "CANCELLED", kinId = "cx"),
            visit("2026-07-20T07:30:00Z", status = "COMPLETED", kinId = "done"),
            visit("2026-07-20T09:00:00Z", status = "SCHEDULED", kinId = "real"),
        )
        assertEquals("real", nextUpcomingSession(sessions, "2026-07-19T12:00:00Z")?.kinfolkId)
    }

    @Test
    fun `next upcoming is null when nothing is coming up`() {
        assertNull(nextUpcomingSession(listOf(visit("2026-07-18T09:00:00Z")), "2026-07-19T12:00:00Z"))
    }

    @Test
    fun `safebox lines drop blanks, keep arrival order, flag codes mono`() {
        val k = Kinfolk(
            id = "k1",
            serviceAddress = "12 Oak St",
            gateCode = "4417",
            entryNotes = "Side door",
            wifiName = "Rivera",
            wifiPassword = "hunter2",
        )
        val lines = safeboxAccessLines(k)
        assertEquals(
            listOf("Address", "Gate / door code", "Entry notes", "WiFi network", "WiFi password"),
            lines.map { it.label },
        )
        assertTrue(lines.first { it.label == "Gate / door code" }.mono)
        assertTrue(!lines.first { it.label == "Address" }.mono)
    }

    @Test
    fun `safebox lines are empty for a household with no access notes`() {
        assertTrue(safeboxAccessLines(Kinfolk(id = "k1")).isEmpty())
    }
}
