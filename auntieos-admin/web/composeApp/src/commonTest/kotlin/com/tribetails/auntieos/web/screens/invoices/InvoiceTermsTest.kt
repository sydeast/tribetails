package com.tribetails.auntieos.web.screens.invoices

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #1178: terms code to due date, the same cases the Android `InvoiceTermsTest` runs. */
class InvoiceTermsTest {

    private data class Case(
        val what: String,
        val code: InvoiceTermsCode,
        val invoiceDate: String,
        val serviceDates: List<String>,
        val now: String,
        val dueDate: String?,
        val isPast: Boolean,
    )

    private val cases = listOf(
        Case("due on receipt is the invoice date", InvoiceTermsCode.DUE_ON_RECEIPT, "2026-08-19", emptyList(), "2026-08-19", "2026-08-19", false),
        Case("net 7 from the invoice date", InvoiceTermsCode.NET_7, "2026-08-19", emptyList(), "2026-08-19", "2026-08-26", false),
        Case("net 14 crosses a month", InvoiceTermsCode.NET_14, "2026-08-19", emptyList(), "2026-08-19", "2026-09-02", false),
        Case("net 30 crosses a year", InvoiceTermsCode.NET_30, "2026-12-15", emptyList(), "2026-12-15", "2027-01-14", false),
        Case("invoice-relative ignores the visits", InvoiceTermsCode.NET_7, "2026-08-19", listOf("2026-01-01"), "2026-08-19", "2026-08-26", false),
        Case("due on the last visit", InvoiceTermsCode.DUE_ON_LAST_VISIT, "2026-08-19", listOf("2026-08-02", "2026-08-11"), "2026-08-11", "2026-08-11", false),
        Case(
            "7 after the last visit, already passed",
            InvoiceTermsCode.NET_7_AFTER_LAST_VISIT, "2026-08-19",
            listOf("2026-08-01T10:00:00.000Z", "2026-08-04T09:00:00.000Z"), "2026-08-19", "2026-08-11", true,
        ),
        Case("14 after the last visit", InvoiceTermsCode.NET_14_AFTER_LAST_VISIT, "2026-08-19", listOf("2026-08-11"), "2026-08-19", "2026-08-25", false),
        Case("service-relative with no visits has no date", InvoiceTermsCode.NET_7_AFTER_LAST_VISIT, "2026-08-19", emptyList(), "2026-08-19", null, false),
        Case("invoice-relative with no date has no date", InvoiceTermsCode.NET_14, "", emptyList(), "2026-08-19", null, false),
        Case("custom is the operator's", InvoiceTermsCode.CUSTOM, "2026-08-19", listOf("2026-08-11"), "2026-08-19", null, false),
    )

    @Test
    fun resolveDueDateFixtureTable() {
        for (c in cases) {
            val out = resolveDueDate(c.code, c.invoiceDate, c.serviceDates, c.now)
            assertEquals(c.dueDate, out.dueDate, c.what)
            assertEquals(c.isPast, out.isPast, c.what)
            assertEquals(out.dueDate != null, out.problem == null, "${c.what}: a date and a problem are exclusive")
        }
    }

    @Test
    fun problemsNameWhatIsMissing() {
        assertEquals(
            "These terms count from the last visit, and there are no visits on this invoice yet. " +
                "Add the visits it covers, or pick the date yourself.",
            resolveDueDate(InvoiceTermsCode.DUE_ON_LAST_VISIT, "2026-08-19", emptyList(), "2026-08-19").problem,
        )
        assertEquals(
            "These terms count from the invoice date, and this invoice has no date on it yet. " +
                "Set the date, or pick the date yourself.",
            resolveDueDate(InvoiceTermsCode.NET_30, "", emptyList(), "2026-08-19").problem,
        )
    }

    @Test
    fun basisDayIsReported() {
        val out = resolveDueDate(InvoiceTermsCode.NET_7_AFTER_LAST_VISIT, "2026-08-19", listOf("2026-08-11", "2026-08-02"), "2026-08-19")
        assertEquals("2026-08-11", out.basisDay)
        assertEquals("2026-08-18", out.dueDate)
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
        assertEquals("nonsense", addDays("nonsense", 7))
    }

    @Test
    fun lastServiceDaySkipsUnreadableEntries() {
        assertEquals("2026-08-11", lastServiceDay(listOf("2026-08-11T23:30:00.000Z", "2026-08-04T01:00:00.000Z")))
        assertEquals("2026-08-04", lastServiceDay(listOf("", "junk", "2026-08-04")))
        assertNull(lastServiceDay(listOf("", "junk")))
    }

    @Test
    fun codesAreOfferedInvoiceRelativeFirstAndCustomLast() {
        assertEquals(
            listOf(
                "due_on_receipt", "net_7", "net_14", "net_30",
                "due_on_last_visit", "net_7_after_last_visit", "net_14_after_last_visit", "custom",
            ),
            invoiceTermsDefs().map { it.wire },
        )
    }
}
