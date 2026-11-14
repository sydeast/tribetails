package com.tribetails.auntieos.web.screens.invoices

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1178, #1966: terms code to due date. THE SAME CASES AND THE SAME EXPECTED
 * DAYS run in `mytribe/functions/test/invoiceTerms.test.ts` over the authority,
 * in the web and Android mirrors, and here, every case in America/Chicago.
 */
class InvoiceTermsTest {

    private data class Case(
        val what: String,
        val code: InvoiceTermsCode,
        val invoiceDate: String,
        val serviceDates: List<String>,
        val now: String,
        val dueDate: String?,
        val isPast: Boolean,
        val appliedCode: InvoiceTermsCode,
    )

    private val cases = listOf(
        Case(
            "due on receipt is the invoice date itself",
            InvoiceTermsCode.DUE_ON_RECEIPT, "2026-08-19", emptyList(),
            "2026-08-19", "2026-08-19", false, InvoiceTermsCode.DUE_ON_RECEIPT,
        ),
        Case(
            "net 14 counts from the invoice date",
            InvoiceTermsCode.NET_14, "2026-08-19", emptyList(),
            "2026-08-19", "2026-09-02", false, InvoiceTermsCode.NET_14,
        ),
        Case(
            "net 30 crosses a month boundary without arithmetic of its own",
            InvoiceTermsCode.NET_30, "2026-08-19", emptyList(),
            "2026-08-19", "2026-09-18", false, InvoiceTermsCode.NET_30,
        ),
        Case(
            "net 7 crosses a year boundary",
            InvoiceTermsCode.NET_7, "2026-12-29", emptyList(),
            "2026-12-29", "2027-01-05", false, InvoiceTermsCode.NET_7,
        ),
        Case(
            "net 7 crosses a leap day",
            InvoiceTermsCode.NET_7, "2028-02-26", emptyList(),
            "2028-02-26", "2028-03-04", false, InvoiceTermsCode.NET_7,
        ),
        Case(
            "after-last-visit terms count from the LAST visit, not the first",
            InvoiceTermsCode.NET_14_AFTER_LAST_VISIT, "2026-08-19", listOf("2026-08-02", "2026-08-11", "2026-08-05"),
            "2026-08-19", "2026-08-25", false, InvoiceTermsCode.NET_14_AFTER_LAST_VISIT,
        ),
        Case(
            "due on the last visit is that visit day",
            InvoiceTermsCode.DUE_ON_LAST_VISIT, "2026-08-01", listOf("2026-08-02", "2026-08-11"),
            "2026-08-01", "2026-08-11", false, InvoiceTermsCode.DUE_ON_LAST_VISIT,
        ),
        Case(
            "due on the first visit is the earliest visit day",
            InvoiceTermsCode.DUE_ON_FIRST_VISIT, "2026-08-01", listOf("2026-08-11", "2026-08-02", "2026-08-05"),
            "2026-08-01", "2026-08-02", false, InvoiceTermsCode.DUE_ON_FIRST_VISIT,
        ),
        Case(
            "1 day after the last visit crosses a month end",
            InvoiceTermsCode.NET_1_AFTER_LAST_VISIT, "2026-08-31", listOf("2026-08-24", "2026-08-31"),
            "2026-08-31", "2026-09-01", false, InvoiceTermsCode.NET_1_AFTER_LAST_VISIT,
        ),
        Case(
            "30 days after the last visit crosses a month end",
            InvoiceTermsCode.NET_30_AFTER_LAST_VISIT, "2026-11-30", listOf("2026-11-30"),
            "2026-11-30", "2026-12-30", false, InvoiceTermsCode.NET_30_AFTER_LAST_VISIT,
        ),
        Case(
            "5 days after the last visit crosses February in a leap year",
            InvoiceTermsCode.NET_5_AFTER_LAST_VISIT, "2028-02-26", listOf("2028-02-26"),
            "2028-02-26", "2028-03-02", false, InvoiceTermsCode.NET_5_AFTER_LAST_VISIT,
        ),
        Case(
            "3 days before the first visit counts back across a month start",
            InvoiceTermsCode.NET_3_BEFORE_FIRST_VISIT, "2026-11-20", listOf("2026-12-09", "2026-12-02"),
            "2026-11-20", "2026-11-29", false, InvoiceTermsCode.NET_3_BEFORE_FIRST_VISIT,
        ),
        Case(
            "1 day before the first visit counts back across a year start",
            InvoiceTermsCode.NET_1_BEFORE_FIRST_VISIT, "2026-12-15", listOf("2027-01-01", "2027-01-04"),
            "2026-12-15", "2026-12-31", false, InvoiceTermsCode.NET_1_BEFORE_FIRST_VISIT,
        ),
        Case(
            "30 days before the first visit counts back across February",
            InvoiceTermsCode.NET_30_BEFORE_FIRST_VISIT, "2026-02-01", listOf("2026-03-15"),
            "2026-02-01", "2026-02-13", false, InvoiceTermsCode.NET_30_BEFORE_FIRST_VISIT,
        ),
        Case(
            "a before-first-visit date before the invoice date is due on receipt",
            InvoiceTermsCode.NET_7_BEFORE_FIRST_VISIT, "2026-11-13", listOf("2026-11-15"),
            "2026-11-13", "2026-11-13", false, InvoiceTermsCode.DUE_ON_RECEIPT,
        ),
        Case(
            "an evening visit in Chicago is counted on its Chicago day, not the UTC day",
            InvoiceTermsCode.DUE_ON_LAST_VISIT, "2026-11-30", listOf("2026-11-28T15:00:00.000Z", "2026-12-01T01:00:00.000Z"),
            "2026-11-30", "2026-11-30", false, InvoiceTermsCode.DUE_ON_LAST_VISIT,
        ),
        Case(
            "an evening first visit is counted on its Chicago day before the count runs back",
            InvoiceTermsCode.NET_2_BEFORE_FIRST_VISIT, "2026-11-20", listOf("2026-12-02T02:00:00.000Z", "2026-12-05T15:00:00.000Z"),
            "2026-11-20", "2026-11-29", false, InvoiceTermsCode.NET_2_BEFORE_FIRST_VISIT,
        ),
        Case(
            "the night the clocks go forward: 05:30Z is still Mar 7 in Chicago",
            InvoiceTermsCode.NET_7_AFTER_LAST_VISIT, "2026-03-08", listOf("2026-03-08T05:30:00.000Z"),
            "2026-03-08", "2026-03-14", false, InvoiceTermsCode.NET_7_AFTER_LAST_VISIT,
        ),
        Case(
            "the day after the clocks go forward: 04:30Z is Mar 8 in Chicago",
            InvoiceTermsCode.DUE_ON_LAST_VISIT, "2026-03-08", listOf("2026-03-09T04:30:00.000Z"),
            "2026-03-08", "2026-03-08", false, InvoiceTermsCode.DUE_ON_LAST_VISIT,
        ),
        Case(
            "the night the clocks go back: 05:30Z on Nov 2 is still Nov 1 in Chicago",
            InvoiceTermsCode.NET_14_BEFORE_FIRST_VISIT, "2026-10-01", listOf("2026-11-02T05:30:00.000Z", "2026-11-03T15:00:00.000Z"),
            "2026-10-01", "2026-10-18", false, InvoiceTermsCode.NET_14_BEFORE_FIRST_VISIT,
        ),
        Case(
            "a time with an offset is read on the Chicago clock",
            InvoiceTermsCode.DUE_ON_LAST_VISIT, "2026-11-30", listOf("2026-11-30T23:30:00-06:00"),
            "2026-11-30", "2026-11-30", false, InvoiceTermsCode.DUE_ON_LAST_VISIT,
        ),
        Case(
            "a time with no zone is already the business clock and keeps its own date",
            InvoiceTermsCode.DUE_ON_LAST_VISIT, "2026-11-30", listOf("2026-11-30T23:30:00"),
            "2026-11-30", "2026-11-30", false, InvoiceTermsCode.DUE_ON_LAST_VISIT,
        ),
        Case(
            "after-last-visit terms with no visits are due on receipt",
            InvoiceTermsCode.NET_14_AFTER_LAST_VISIT, "2026-08-19", emptyList(),
            "2026-08-19", "2026-08-19", false, InvoiceTermsCode.DUE_ON_RECEIPT,
        ),
        Case(
            "before-first-visit terms with no visits are due on receipt",
            InvoiceTermsCode.NET_7_BEFORE_FIRST_VISIT, "2026-08-19", emptyList(),
            "2026-08-19", "2026-08-19", false, InvoiceTermsCode.DUE_ON_RECEIPT,
        ),
        Case(
            "unreadable visit dates count as no visits, so due on receipt",
            InvoiceTermsCode.DUE_ON_LAST_VISIT, "2026-08-19", listOf("", "sometime last week", "2026-02-30"),
            "2026-08-19", "2026-08-19", false, InvoiceTermsCode.DUE_ON_RECEIPT,
        ),
        Case(
            "no visits and no invoice date resolve to no date at all",
            InvoiceTermsCode.DUE_ON_FIRST_VISIT, "", emptyList(),
            "2026-08-19", null, false, InvoiceTermsCode.DUE_ON_RECEIPT,
        ),
        Case(
            "invoice-relative terms with no invoice date resolve to no date at all",
            InvoiceTermsCode.NET_14, "", listOf("2026-08-11"),
            "2026-08-19", null, false, InvoiceTermsCode.NET_14,
        ),
        Case(
            "custom terms decide nothing, by design",
            InvoiceTermsCode.CUSTOM, "2026-08-19", listOf("2026-08-11"),
            "2026-08-19", null, false, InvoiceTermsCode.CUSTOM,
        ),
        Case(
            "due on the last visit, invoiced after it, is due on receipt",
            InvoiceTermsCode.DUE_ON_LAST_VISIT, "2026-08-19", listOf("2026-08-02", "2026-08-11"),
            "2026-08-19", "2026-08-19", false, InvoiceTermsCode.DUE_ON_RECEIPT,
        ),
        Case(
            "after-last-visit terms already behind today are reported, not moved",
            InvoiceTermsCode.NET_7_AFTER_LAST_VISIT, "2026-07-21", listOf("2026-07-20"),
            "2026-08-19", "2026-07-27", true, InvoiceTermsCode.NET_7_AFTER_LAST_VISIT,
        ),
        Case(
            "a backdated invoice held to its own date is still reported as past",
            InvoiceTermsCode.NET_3_BEFORE_FIRST_VISIT, "2026-11-10", listOf("2026-11-12"),
            "2026-11-13", "2026-11-10", true, InvoiceTermsCode.DUE_ON_RECEIPT,
        ),
        Case(
            "before-first-visit terms that land on the invoice date are kept",
            InvoiceTermsCode.NET_2_BEFORE_FIRST_VISIT, "2026-11-13", listOf("2026-11-15"),
            "2026-11-13", "2026-11-13", false, InvoiceTermsCode.NET_2_BEFORE_FIRST_VISIT,
        ),
        Case(
            "with no invoice date there is nothing to hold the due date to",
            InvoiceTermsCode.NET_7_BEFORE_FIRST_VISIT, "", listOf("2026-11-15"),
            "2026-11-13", "2026-11-08", true, InvoiceTermsCode.NET_7_BEFORE_FIRST_VISIT,
        ),
    )

    @Test
    fun resolveDueDateFixtureTable() {
        assertEquals(33, cases.size)
    }

    @Test
    fun `a bill is never due before its own date, and the resolution says why`() {
        val floored = resolveDueDate(InvoiceTermsCode.NET_3_BEFORE_FIRST_VISIT, "2026-11-13", listOf("2026-11-14"), "2026-11-13")
        assertEquals("2026-11-13", floored.dueDate)
        assertEquals(InvoiceTermsCode.DUE_ON_RECEIPT, floored.appliedCode)
        assertTrue(floored.beforeInvoiceDate)
        assertFalse(resolveDueDate(InvoiceTermsCode.NET_3_BEFORE_FIRST_VISIT, "2026-11-13", emptyList(), "2026-11-13").beforeInvoiceDate)
        assertFalse(
            resolveDueDate(InvoiceTermsCode.NET_3_BEFORE_FIRST_VISIT, "2026-11-13", listOf("2026-11-16"), "2026-11-13").beforeInvoiceDate,
        )
        assertFalse(resolveDueDate(InvoiceTermsCode.NET_14, "2026-11-13", emptyList(), "2026-11-13").beforeInvoiceDate)
        for (c in cases) {
            val out = resolveDueDate(c.code, c.invoiceDate, c.serviceDates, c.now, "America/Chicago")
            assertEquals(c.dueDate, out.dueDate, c.what)
            assertEquals(c.isPast, out.isPast, c.what)
            assertEquals(c.appliedCode, out.appliedCode, c.what)
            assertEquals(out.dueDate != null, out.problem == null, "${c.what}: a date and a problem are exclusive")
        }
    }

    @Test
    fun visitDaysFollowTheZoneAndFallBackToChicago() {
        assertEquals(
            "2026-11-30",
            resolveDueDate(InvoiceTermsCode.DUE_ON_LAST_VISIT, "2026-11-30", listOf("2026-12-01T01:00:00.000Z"), "2026-11-30").dueDate,
        )
        assertEquals(
            "2026-12-01",
            resolveDueDate(
                InvoiceTermsCode.DUE_ON_LAST_VISIT, "2026-11-30", listOf("2026-12-01T01:00:00.000Z"), "2026-11-30", "Asia/Tokyo",
            ).dueDate,
        )
        assertEquals("2026-11-30", serviceDayOf("2026-12-01T01:00:00.000Z", "Not/AZone"))
    }

    @Test
    fun problemsNameWhatIsMissing() {
        val sentence = "These terms count from the invoice date, and this invoice has no date on it yet. " +
            "Set the date, or pick the date yourself."
        assertEquals(sentence, resolveDueDate(InvoiceTermsCode.NET_30, "", emptyList(), "2026-08-19").problem)
        // No visits and no date: due on receipt, with the same sentence.
        val visits = resolveDueDate(InvoiceTermsCode.DUE_ON_LAST_VISIT, "", emptyList(), "2026-08-19")
        assertEquals(sentence, visits.problem)
        assertEquals(InvoiceTermsCode.DUE_ON_RECEIPT, visits.appliedCode)
    }

    @Test
    fun basisDayIsReported() {
        val out = resolveDueDate(InvoiceTermsCode.NET_7_AFTER_LAST_VISIT, "2026-08-19", listOf("2026-08-11", "2026-08-02"), "2026-08-19")
        assertEquals("2026-08-11", out.basisDay)
        assertEquals("2026-08-18", out.dueDate)
        val first = resolveDueDate(InvoiceTermsCode.NET_3_BEFORE_FIRST_VISIT, "2026-08-01", listOf("2026-08-11", "2026-08-05"), "2026-08-01")
        assertEquals("2026-08-05", first.basisDay)
    }

    @Test
    fun calendarDaysAreExact() {
        assertTrue(isCalendarDay("2028-02-29"))
        assertFalse(isCalendarDay("2026-02-29"))
        assertFalse(isCalendarDay("2026-02-30"))
        assertFalse(isCalendarDay("2026-13-01"))
        assertFalse(isCalendarDay("2026-8-1"))
        assertFalse(isCalendarDay(""))
    }

    @Test
    fun addDaysCrossesMonthsYearsAndLeapDays() {
        assertEquals("2026-09-02", addDays("2026-08-19", 14))
        assertEquals("2027-01-05", addDays("2026-12-29", 7))
        assertEquals("2028-03-04", addDays("2028-02-26", 7))
        assertEquals("2026-02-28", addDays("2026-03-01", -1))
        assertEquals("2026-12-31", addDays("2027-01-01", -1))
        assertEquals("nonsense", addDays("nonsense", 7))
    }

    @Test
    fun serviceDaysAreBusinessDaysAndSkipUnreadableEntries() {
        assertEquals("2026-08-11", lastServiceDay(listOf("2026-08-11T23:30:00.000Z", "2026-08-04T01:00:00.000Z")))
        // 01:00Z on Aug 4 is 8 PM on Aug 3 in Chicago.
        assertEquals("2026-08-03", firstServiceDay(listOf("2026-08-11T23:30:00.000Z", "2026-08-04T01:00:00.000Z")))
        assertEquals("2026-08-04", lastServiceDay(listOf("", "junk", "2026-08-04")))
        assertNull(lastServiceDay(listOf("", "junk")))
        assertEquals("2026-11-30", serviceDayOf("2026-11-30T19:00"))
        assertEquals("2026-11-30", serviceDayOf("2026-11-30T23:30:00-06:00"))
        assertNull(serviceDayOf("2026-02-30T10:00:00"))
    }

    @Test
    fun codesAreOfferedSettingOptionsFirstThenInvoiceDateCountsThenCustom() {
        assertEquals(25, invoiceTermsDefs().size)
        assertEquals(InvoiceTermsCode.DUE_ON_RECEIPT, invoiceTermsDefs().first())
        assertEquals(InvoiceTermsCode.CUSTOM, invoiceTermsDefs().last())
        assertEquals("Due 1 day after the last visit", InvoiceTermsCode.NET_1_AFTER_LAST_VISIT.label)
        assertEquals("Due 1 day before the first visit", InvoiceTermsCode.NET_1_BEFORE_FIRST_VISIT.label)
        invoiceTermsDefs().forEach { assertFalse(Regex("""\b1 days\b""").containsMatchIn(it.label), it.wire) }
    }

    @Test
    fun thePaymentTermsSettingOffersTheRuledOptionsAndStartsOnReceipt() {
        assertEquals(
            listOf(
                "due_on_receipt", "due_on_first_visit", "due_on_last_visit",
                "net_1_after_last_visit", "net_2_after_last_visit", "net_3_after_last_visit",
                "net_4_after_last_visit", "net_5_after_last_visit", "net_6_after_last_visit",
                "net_7_after_last_visit", "net_14_after_last_visit", "net_30_after_last_visit",
                "net_1_before_first_visit", "net_2_before_first_visit", "net_3_before_first_visit",
                "net_4_before_first_visit", "net_5_before_first_visit", "net_6_before_first_visit",
                "net_7_before_first_visit", "net_14_before_first_visit", "net_30_before_first_visit",
            ),
            PAYMENT_TERMS_SETTING_CODES.map { it.wire },
        )
        assertEquals(InvoiceTermsCode.DUE_ON_RECEIPT, DEFAULT_PAYMENT_TERMS)
        assertEquals(InvoiceTermsCode.DUE_ON_RECEIPT, paymentTermsSettingOf(null))
        assertEquals(InvoiceTermsCode.DUE_ON_RECEIPT, paymentTermsSettingOf("net_14"))
        assertEquals(InvoiceTermsCode.DUE_ON_RECEIPT, paymentTermsSettingOf("custom"))
        assertEquals(InvoiceTermsCode.NET_7_BEFORE_FIRST_VISIT, paymentTermsSettingOf(" net_7_before_first_visit "))
    }
}
