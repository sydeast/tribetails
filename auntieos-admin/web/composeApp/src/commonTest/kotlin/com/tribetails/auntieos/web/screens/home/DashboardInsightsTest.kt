package com.tribetails.auntieos.web.screens.home

import com.tribetails.auntieos.web.data.ExpenseItem
import com.tribetails.auntieos.web.data.ExpirationItem
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.SupplyItem
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
            _id = "k1",
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
        assertTrue(safeboxAccessLines(Kinfolk(_id = "k1")).isEmpty())
    }

    // ── AO-37 care flags ────────────────────────────────────────────────────────

    private fun kin(id: String, reactive: Boolean = false, meds: String = "", feeding: String = "", name: String = "Rex") =
        Kin(_id = id, name = name, reactive = reactive, medicationHealthNotes = meds, feedingBrand = feeding)

    private fun careSession(date: String, kinIds: List<String>, status: String = "SCHEDULED", household: String = "the Bs") =
        KinCareSession(kinfolkName = household, startTime = date, status = status, kinIds = kinIds)

    @Test
    fun `care flags emit reactive, medication, feeding and sort reactive first`() {
        val kinById = mapOf("k1" to kin("k1", reactive = true, meds = "2 pills AM", feeding = "Blue Buffalo", name = "Rex"))
        val sessions = listOf(careSession("2026-07-18T09:00:00Z", listOf("k1")))
        val flags = careFlags(sessions, kinById, "2026-07-18")
        assertEquals(listOf("reactive", "medication", "feeding"), flags.map { it.kind })
        assertEquals("Reactive, handle with care", flags.first().text)
        assertEquals("2 pills AM", flags[1].text)
        assertEquals("Blue Buffalo", flags[2].text)
        assertEquals("Rex", flags.first().kinName)
        assertEquals("the Bs", flags.first().household)
    }

    @Test
    fun `care flags dedup by kin and kind across two sessions`() {
        val kinById = mapOf("k1" to kin("k1", meds = "insulin"))
        val sessions = listOf(
            careSession("2026-07-18T09:00:00Z", listOf("k1")),
            careSession("2026-07-18T14:00:00Z", listOf("k1")),
        )
        assertEquals(1, careFlags(sessions, kinById, "2026-07-18").size)
    }

    @Test
    fun `care flags skip cancelled sessions, other days, and unflagged kin`() {
        val kinById = mapOf(
            "k1" to kin("k1", meds = "pill"),
            "k2" to kin("k2"),  // nothing to flag
        )
        val sessions = listOf(
            careSession("2026-07-18T09:00:00Z", listOf("k1"), status = "CANCELLED"),  // cancelled
            careSession("2026-07-19T09:00:00Z", listOf("k1")),                        // other day
            careSession("2026-07-18T10:00:00Z", listOf("k2")),                        // unflagged kin
        )
        assertTrue(careFlags(sessions, kinById, "2026-07-18").isEmpty())
    }

    @Test
    fun `care flags fall back to the single kinId when kinIds is empty`() {
        val kinById = mapOf("solo" to kin("solo", reactive = true))
        val sessions = listOf(KinCareSession(kinfolkName = "the Cs", startTime = "2026-07-18T09:00:00Z", kinId = "solo"))
        assertEquals(1, careFlags(sessions, kinById, "2026-07-18").size)
    }

    // ── AO-39 expiration countdown ──────────────────────────────────────────────

    private fun exp(id: String, dateIso: String, label: String = "Gate code", kind: String = "gateCode") =
        ExpirationItem(_id = id, label = label, dateIso = dateIso, kinfolkId = "", kind = kind)

    @Test
    fun `expirations keep only today through the window, sorted ascending`() {
        val items = listOf(
            exp("a", "2026-09-20"),   // beyond 60 days
            exp("b", "2026-07-25"),   // in window
            exp("c", "2026-07-10"),   // past
            exp("d", "2026-07-18"),   // today
        )
        val rows = upcomingExpirations(items, "2026-07-18", withinDays = 60)
        assertEquals(listOf("2026-07-18", "2026-07-25"), rows.map { it.dateIso })
        assertEquals(0, rows.first().daysUntil)
        assertEquals(7, rows[1].daysUntil)
    }

    @Test
    fun `expirations drop undated rows and honor a bad today`() {
        assertTrue(upcomingExpirations(listOf(exp("a", "")), "2026-07-18").isEmpty())
        assertTrue(upcomingExpirations(listOf(exp("a", "2026-07-25")), "not-a-date").isEmpty())
    }

    // ── AO-40 expense quick-log ─────────────────────────────────────────────────

    private fun expense(id: String, occurredAt: String, cents: Int = 100, kind: String = "gas", note: String = "") =
        ExpenseItem(_id = id, kind = kind, amountCents = cents, note = note, occurredAt = occurredAt)

    @Test
    fun `recent expenses are newest first and capped`() {
        val list = listOf(
            expense("a", "2026-07-10T09:00:00Z"),
            expense("b", "2026-07-16T09:00:00Z"),
            expense("c", "2026-07-12T09:00:00Z"),
        )
        assertEquals(listOf("b", "c", "a"), recentExpenses(list).map { it._id })
        assertEquals(2, recentExpenses(list, limit = 2).size)
    }

    @Test
    fun `format cents renders dollars with two-digit cents and a leading sign`() {
        assertEquals("$12.34", formatCents(1234))
        assertEquals("$0.05", formatCents(5))
        assertEquals("$8.00", formatCents(800))
        assertEquals("-$1.50", formatCents(-150))
    }

    // ── AO-41 supplies tracker ──────────────────────────────────────────────────

    private fun supply(id: String, onHand: Int, par: Int, name: String = "Poop bags", unit: String = "rolls") =
        SupplyItem(_id = id, name = name, onHand = onHand, par = par, unit = unit)

    @Test
    fun `low supplies keep onHand at or below par, most depleted first`() {
        val list = listOf(
            supply("ok", onHand = 10, par = 3),    // healthy, excluded
            supply("low", onHand = 2, par = 5),     // shortfall -3
            supply("at", onHand = 4, par = 4),      // shortfall 0 (at par, included)
            supply("empty", onHand = 0, par = 6),   // shortfall -6
        )
        assertEquals(listOf("empty", "low", "at"), lowSupplies(list).map { it._id })
    }

    // ── AO-35 route optimizer helpers ───────────────────────────────────────────

    @Test
    fun `format miles rounds to one decimal`() {
        assertEquals("12.3 mi", formatMiles(12.34))
        assertEquals("0.0 mi", formatMiles(0.0))
    }

    @Test
    fun `format duration reads hours and minutes`() {
        assertEquals("45m", formatDuration(45))
        assertEquals("1h 05m", formatDuration(65))
        assertEquals("2h 00m", formatDuration(120))
        assertEquals("0m", formatDuration(-5))
    }
}
