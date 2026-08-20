package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The terms resolver's fixture table.
 *
 * THE SAME CASES AND THE SAME EXPECTED DAYS run in
 * `mytribe/functions/test/invoiceTerms.test.ts` and in
 * `auntieos-admin/src/lib/invoiceTerms.test.ts`, so a rule changed on one of the
 * three copies and not the others turns a suite red. Keep the tables identical;
 * that is the whole point of them. `InvoiceTermsParityTest` guards the rule
 * TABLE against the server file on disk, where this guards what the table
 * resolves.
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
    )

    private val cases = listOf(
        Case(
            "due on receipt is the invoice date itself",
            InvoiceTermsCode.DUE_ON_RECEIPT, "2026-08-19", emptyList(), "2026-08-19", "2026-08-19", false,
        ),
        Case(
            "net 14 counts from the invoice date",
            InvoiceTermsCode.NET_14, "2026-08-19", emptyList(), "2026-08-19", "2026-09-02", false,
        ),
        Case(
            "net 30 crosses a month boundary without arithmetic of its own",
            InvoiceTermsCode.NET_30, "2026-08-19", emptyList(), "2026-08-19", "2026-09-18", false,
        ),
        Case(
            "net 7 crosses a year boundary",
            InvoiceTermsCode.NET_7, "2026-12-29", emptyList(), "2026-12-29", "2027-01-05", false,
        ),
        Case(
            "net 7 crosses a leap day",
            InvoiceTermsCode.NET_7, "2028-02-26", emptyList(), "2028-02-26", "2028-03-04", false,
        ),
        Case(
            "service-relative terms count from the LAST visit, not the first",
            InvoiceTermsCode.NET_14_AFTER_LAST_VISIT,
            "2026-08-19",
            listOf("2026-08-02", "2026-08-11", "2026-08-05"),
            "2026-08-19",
            "2026-08-25",
            false,
        ),
        Case(
            // Already behind today, and reported as such rather than moved.
            "due on the last visit is that visit day",
            InvoiceTermsCode.DUE_ON_LAST_VISIT,
            "2026-08-19",
            listOf("2026-08-02", "2026-08-11"),
            "2026-08-19",
            "2026-08-11",
            true,
        ),
        Case(
            "a service-relative due date already in the past resolves to the real past day",
            InvoiceTermsCode.NET_7_AFTER_LAST_VISIT,
            "2026-08-19",
            listOf("2026-07-20"),
            "2026-08-19",
            "2026-07-27",
            true,
        ),
        Case(
            "due today is due, not overdue",
            InvoiceTermsCode.NET_7_AFTER_LAST_VISIT,
            "2026-08-19",
            listOf("2026-08-12"),
            "2026-08-19",
            "2026-08-19",
            false,
        ),
        Case(
            "ISO timestamps are read as their calendar day",
            InvoiceTermsCode.DUE_ON_LAST_VISIT,
            "2026-08-19",
            listOf("2026-08-11T23:30:00.000Z", "2026-08-04T01:00:00.000Z"),
            "2026-08-01",
            "2026-08-11",
            false,
        ),
        Case(
            "service-relative terms with no visits resolve to no date at all",
            InvoiceTermsCode.NET_14_AFTER_LAST_VISIT, "2026-08-19", emptyList(), "2026-08-19", null, false,
        ),
        Case(
            "service-relative terms ignore unreadable visit dates entirely",
            InvoiceTermsCode.DUE_ON_LAST_VISIT,
            "2026-08-19",
            listOf("", "sometime last week", "2026-02-30"),
            "2026-08-19",
            null,
            false,
        ),
        Case(
            "invoice-relative terms with no invoice date resolve to no date at all",
            InvoiceTermsCode.NET_14, "", listOf("2026-08-11"), "2026-08-19", null, false,
        ),
        Case(
            "custom terms decide nothing, by design",
            InvoiceTermsCode.CUSTOM, "2026-08-19", listOf("2026-08-11"), "2026-08-19", null, false,
        ),
    )

    @Test
    fun `resolveDueDate fixture table`() {
        cases.forEach { c ->
            val out = resolveDueDate(c.code, c.invoiceDate, c.serviceDates, c.now)
            assertEquals(c.what, c.dueDate, out.dueDate)
            assertEquals(c.what, c.isPast, out.isPast)
            // A missing date always says why, and a resolved one never carries a
            // leftover complaint: the two fields are exclusive by construction.
            assertEquals(c.what, out.dueDate != null, out.problem == null)
        }
    }

    @Test
    fun `problems name the visits when service-relative terms have none`() {
        val problem = resolveDueDate(
            InvoiceTermsCode.NET_14_AFTER_LAST_VISIT,
            "2026-08-19",
            emptyList(),
            "2026-08-19",
        ).problem
        assertTrue(problem!!.contains("no visits on this invoice yet"))
        assertTrue(problem.contains("pick the date yourself"))
    }

    @Test
    fun `problems name the invoice date when invoice-relative terms have none`() {
        val out = resolveDueDate(InvoiceTermsCode.NET_30, "", emptyList(), "2026-08-19")
        assertTrue(out.problem!!.contains("no date on it yet"))
    }

    @Test
    fun `custom terms say the date is the operator's to pick`() {
        val out = resolveDueDate(InvoiceTermsCode.CUSTOM, "2026-08-19", emptyList(), "2026-08-19")
        assertNull(out.dueDate)
        assertTrue(out.problem!!.contains("Choose the date yourself"))
    }

    @Test
    fun `the day the count ran from is reported, so a surprising date can be traced`() {
        val out = resolveDueDate(
            InvoiceTermsCode.NET_14_AFTER_LAST_VISIT,
            "2026-08-19",
            listOf("2026-08-02", "2026-08-11"),
            "2026-08-19",
        )
        assertEquals("2026-08-11", out.basisDay)
    }

    @Test
    fun `every code has a rule, a label and household-facing words`() {
        assertEquals(8, InvoiceTermsCode.entries.size)
        InvoiceTermsCode.entries.forEach { code ->
            assertTrue(code.wire, code.label.isNotBlank())
            assertTrue(code.wire, code.words.isNotBlank())
            assertTrue(code.wire, code.days >= 0)
        }
    }

    @Test
    fun `rules are offered invoice-relative before visit-relative, escape hatch last`() {
        assertEquals(
            listOf(
                "due_on_receipt",
                "net_7",
                "net_14",
                "net_30",
                "due_on_last_visit",
                "net_7_after_last_visit",
                "net_14_after_last_visit",
                "custom",
            ),
            invoiceTermsDefs().map { it.wire },
        )
    }

    @Test
    fun `a stored code reads back, and anything else does not`() {
        assertEquals(InvoiceTermsCode.NET_14, parseInvoiceTermsCode("net_14"))
        assertEquals(InvoiceTermsCode.NET_14, parseInvoiceTermsCode("  net_14  "))
        assertNull(parseInvoiceTermsCode("Net 14"))
        assertNull(parseInvoiceTermsCode(""))
        assertNull(parseInvoiceTermsCode(null))
        // Legacy free-text terms carry no code, and inventing one would claim a
        // rule nobody chose.
        assertNull(parseInvoiceTermsCode("due in a fortnight"))
    }

    @Test
    fun `calendar days are accepted and impossible ones are refused`() {
        assertTrue(isCalendarDay("2026-08-19"))
        assertTrue(isCalendarDay("2028-02-29"))
        assertFalse(isCalendarDay("2026-02-29"))
        assertFalse(isCalendarDay("2026-02-30"))
        assertFalse(isCalendarDay("2026-13-01"))
        assertFalse(isCalendarDay("2026-8-19"))
        assertFalse(isCalendarDay(""))
        assertFalse(isCalendarDay("2026-08-19T00:00:00Z"))
    }

    @Test
    fun `days are added across months, years and leap days`() {
        assertEquals("2026-09-02", addDays("2026-08-19", 14))
        assertEquals("2027-01-05", addDays("2026-12-29", 7))
        assertEquals("2028-03-04", addDays("2028-02-26", 7))
        assertEquals("2026-08-19", addDays("2026-08-19", 0))
        // A value that is not a day comes back untouched rather than as a
        // plausible wrong date.
        assertEquals("nonsense", addDays("nonsense", 7))
    }

    @Test
    fun `the latest readable service day wins and the rest are ignored`() {
        assertEquals("2026-08-11", lastServiceDay(listOf("2026-08-02", "2026-08-11", "2026-08-05")))
        assertEquals("2026-08-11", lastServiceDay(listOf("2026-08-11T23:30:00.000Z", "2026-08-04T01:00:00.000Z")))
        assertEquals("2026-08-04", lastServiceDay(listOf("", "junk", "2026-08-04")))
        assertNull(lastServiceDay(emptyList()))
        assertNull(lastServiceDay(listOf("", "junk")))
    }

    @Test
    fun `a resolution that names a date never also names a problem`() {
        val out = resolveDueDate(InvoiceTermsCode.NET_7, "2026-08-19", emptyList(), "2026-08-19")
        assertNotNull(out.dueDate)
        assertNull(out.problem)
    }
}
