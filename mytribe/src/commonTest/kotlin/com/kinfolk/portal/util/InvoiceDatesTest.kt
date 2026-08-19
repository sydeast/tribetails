package com.kinfolk.portal.util

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The day and the working behind an invoice line, as a household reads them
 * (#408).
 *
 * Both mirror `mytribe/web/src/lib/invoiceFormat.ts` and
 * `mytribe/web/src/screens/InvoiceDetail.tsx`, so one invoice reads the same on
 * both portals. These are the assertions that keep that true.
 */
class InvoiceDatesTest {

    @Test
    fun `an ISO timestamp reads as the day it names`() {
        // The case #408 created: a line bound to a visit carries the visit's
        // full startTime, and the screen used to print it verbatim.
        assertEquals("Jul 10, 2026", invoiceDayLabel("2026-07-10T14:00:00.000Z"))
    }

    @Test
    fun `a bare day reads the same as the timestamp of that day`() {
        assertEquals("Jul 10, 2026", invoiceDayLabel("2026-07-10"))
    }

    @Test
    fun `the day is taken as written, not shifted into the reader's zone`() {
        // 8pm UTC is still the 10th. A visit does not move to another day
        // because the household opened the invoice while travelling.
        assertEquals("Jul 10, 2026", invoiceDayLabel("2026-07-10T20:00:00.000Z"))
        assertEquals("Jul 11, 2026", invoiceDayLabel("2026-07-11T02:00:00.000Z"))
    }

    @Test
    fun `zero-pads the day so a column of dates lines up`() {
        assertEquals("Jun 01, 2026", invoiceDayLabel("2026-06-01"))
    }

    @Test
    fun `nothing at all reads as nothing, never as today`() {
        assertEquals("", invoiceDayLabel(null))
        assertEquals("", invoiceDayLabel(""))
        assertEquals("", invoiceDayLabel("   "))
    }

    @Test
    fun `an unreadable value is shown as itself rather than hidden`() {
        // This collection has held free text in its date fields for years.
        // Showing what is stored beats hiding it or inventing a date.
        assertEquals("sometime in June", invoiceDayLabel("sometime in June"))
        assertEquals("2026-13-40", invoiceDayLabel("2026-13-40"))
    }

    @Test
    fun `a repeated line shows its quantity and unit price`() {
        assertEquals("3 x \$20.00", invoiceLineUnits(3.0, 2000L))
    }

    @Test
    fun `a fractional quantity keeps its fraction`() {
        assertEquals("2.5 x \$30.00", invoiceLineUnits(2.5, 3000L))
    }

    @Test
    fun `a quantity of one says nothing, because it would only repeat the amount`() {
        assertEquals("", invoiceLineUnits(1.0, 2500L))
    }

    @Test
    fun `a row with no breakdown says nothing rather than guessing at one`() {
        // A line rebuilt from a visit knows only its total.
        assertEquals("", invoiceLineUnits(null, 2500L))
        assertEquals("", invoiceLineUnits(3.0, null))
    }
}
