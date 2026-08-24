package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import java.util.Locale
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/** Android mirror of web KinfolkProfileFeedsTest. */
class KinfolkProfileFeedsTest {

    // The invoice row's date is spelled for the operator's locale, so the
    // expected spelling below is pinned rather than inherited from whatever
    // machine runs the suite. Restored after, the way #339 does it.
    private val hostLocale = Locale.getDefault()

    @Before fun pinLocale() = Locale.setDefault(Locale.US)

    @After fun restoreLocale() = Locale.setDefault(hostLocale)

    @Test
    fun upcoming_keepsFutureScheduledForKinfolk_sortedAsc() {
        val sessions = listOf(
            KinCareSession(id = "a", kinfolkId = "k1", status = "scheduled", startTime = "2026-06-10T09:00:00Z"),
            KinCareSession(id = "b", kinfolkId = "k1", status = "scheduled", startTime = "2026-06-08T09:00:00Z"),
            KinCareSession(id = "past", kinfolkId = "k1", status = "scheduled", startTime = "2026-06-01T09:00:00Z"),
            KinCareSession(id = "other", kinfolkId = "k2", status = "scheduled", startTime = "2026-06-09T09:00:00Z"),
            KinCareSession(id = "done", kinfolkId = "k1", status = "completed", startTime = "2026-06-12T09:00:00Z"),
        )
        val out = upcomingVisitsFor(sessions, "k1", nowIso = "2026-06-07T00:00:00Z")
        assertEquals(listOf("b", "a"), out.map { it.id })
    }

    @Test
    fun `the upcoming window honours a far edge when one is given`() {
        val sessions = listOf(
            KinCareSession(id = "inside", kinfolkId = "k1", status = "scheduled", startTime = "2026-06-09T09:00:00Z"),
            KinCareSession(id = "beyond", kinfolkId = "k1", status = "scheduled", startTime = "2026-07-30T09:00:00Z"),
        )
        val now = java.time.Instant.parse("2026-06-07T00:00:00Z")
        val through = horizonIso(now)
        assertEquals(
            listOf("inside"),
            upcomingVisitsFor(sessions, "k1", nowIso = now.toString(), throughIso = through).map { it.id },
        )
        // Null means no far edge, which is what this function always did.
        assertEquals(
            listOf("inside", "beyond"),
            upcomingVisitsFor(sessions, "k1", nowIso = now.toString(), throughIso = null).map { it.id },
        )
    }
    @Test
    fun `the horizon lands the requested number of days out`() {
        assertEquals(
            "2026-06-14",
            horizonIso(java.time.Instant.parse("2026-06-07T00:00:00Z")).take(10),
        )
    }
    @Test
    fun `a feed count says total under the cap and refuses to under a capped read`() {
        assertEquals("3 total", feedCountMeta(3, 3, capped = false))
        assertEquals("5 of 12 total", feedCountMeta(5, 12, capped = false))
        // The subset trap: the card counts a subset, the cap applies to the raw
        // read, so cappedness cannot be inferred from the count shown.
        assertEquals("5 of 150+ loaded", feedCountMeta(5, 150, capped = true))
    }
    // ── The hero's tenure chip ────────────────────────────────────────────────
    @Test
    fun `tenure counts whole months and does not credit one that has not completed`() {
        val today = java.time.LocalDate.of(2026, 8, 17)
        assertEquals("14 months", tenureLabel("2025-06-17", today))
        assertEquals("13 months", tenureLabel("2025-06-18", today))
        assertEquals("1 month", tenureLabel("2026-07-17", today))
        assertEquals("new", tenureLabel("2026-08-01", today))
        assertEquals("3 years", tenureLabel("2023-01-17", today))
        assertEquals("14 months", tenureLabel("2025-06-17T12:34:56.789Z", today))
    }
    @Test
    fun `tenure claims nothing it cannot read, and nothing about a future join date`() {
        val today = java.time.LocalDate.of(2026, 8, 17)
        assertEquals(null, tenureLabel("", today))
        assertEquals(null, tenureLabel("07/24/2026", today))
        assertEquals(null, tenureLabel("2026-02-30", today))
        assertEquals(null, tenureLabel("sometime in 2025", today))
        assertEquals(null, tenureLabel("2027-01-01", today))
    }
    @Test
    fun recentTales_sentOnlyForKinfolk_newestFirst() {
        val reports = listOf(
            KinCareReport(id = "r1", kinfolkId = "k1", status = "SENT", sentAt = "2026-06-05T10:00:00Z"),
            KinCareReport(id = "r2", kinfolkId = "k1", status = "SENT", sentAt = "2026-06-06T10:00:00Z"),
            KinCareReport(id = "draft", kinfolkId = "k1", status = "DRAFT"),
            KinCareReport(id = "other", kinfolkId = "k2", status = "SENT", sentAt = "2026-06-07T10:00:00Z"),
        )
        assertEquals(listOf("r2", "r1"), recentTalesFor(reports, "k1").map { it.id })
    }

    @Test
    fun invoices_forKinfolk_newestFirst() {
        val invs = listOf(
            Invoice(id = "i1", kinfolkId = "k1", date = "2026-05-01"),
            Invoice(id = "i2", kinfolkId = "k1", date = "2026-06-01"),
            Invoice(id = "other", kinfolkId = "k2", date = "2026-07-01"),
        )
        assertEquals(listOf("i2", "i1"), invoicesForKinfolk(invs, "k1").map { it.id })
    }

    // ── The INVOICES row label ────────────────────────────────────────────────
    //
    // `invoices.date` is FREE TEXT and it was confirmed as such in production by
    // PR #241: the collection holds operator-typed strings like "February 17,
    // 2026". This row printed `date.take(10)` of it.

    @Test
    fun `an operator-typed invoice date survives whole rather than becoming a different one`() {
        // Ten characters of this is "February 1": a real date, not this
        // invoice's, and nothing on the row says it was cut.
        assertEquals(
            "1029 · February 17, 2026",
            kinfolkInvoiceFeedLabel(Invoice(id = "i1", invoiceNumber = "1029", date = "February 17, 2026")),
        )
    }

    @Test
    fun `a stored ISO day is spelled out instead of left as machine text`() {
        assertEquals(
            "1029 · Jul 20, 2026",
            kinfolkInvoiceFeedLabel(Invoice(id = "i1", invoiceNumber = "1029", date = "2026-07-20")),
        )
    }

    @Test
    fun `an ISO instant keeps its stored day and loses only the clock`() {
        // The literal characters of the day, never a zone conversion: an invoice
        // stamped the 20th reads as the 20th wherever the phone is.
        assertEquals(
            "1029 · Jul 20, 2026",
            kinfolkInvoiceFeedLabel(Invoice(id = "i1", invoiceNumber = "1029", date = "2026-07-20T23:32:00Z")),
        )
    }

    @Test
    fun `an ambiguous slash date is not guessed at`() {
        // Month-first and day-first cannot be told apart, so it prints as stored.
        assertEquals(
            "1029 · 07/24/2026",
            kinfolkInvoiceFeedLabel(Invoice(id = "i1", invoiceNumber = "1029", date = "07/24/2026")),
        )
    }

    @Test
    fun `an invoice with no date is its number alone, not a number trailing a separator`() {
        assertEquals("1029", kinfolkInvoiceFeedLabel(Invoice(id = "i1", invoiceNumber = "1029", date = "")))
        assertEquals("1029", kinfolkInvoiceFeedLabel(Invoice(id = "i1", invoiceNumber = "1029", date = "   ")))
    }

    @Test
    fun `an invoice with no number is still named`() {
        assertEquals(
            "Invoice · Jul 20, 2026",
            kinfolkInvoiceFeedLabel(Invoice(id = "i1", invoiceNumber = "", date = "2026-07-20")),
        )
    }
}
