package com.tribetails.auntieos.web.screens.invoices
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.screens.directory.parseCreditDollarsToCents
import com.tribetails.auntieos.web.util.formatUsd
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
/**
 * #1495: every money box on the desktop console reads a typed thousands comma
 * the same way, through [normalizeMoneyText]. The record-payment boxes used to
 * refuse "1,234.50" while the composer and the credit form accepted it.
 */
class MoneyInputCommaTest {
    private val invoice = Invoice(
        _id = "inv1", kinfolkId = "kf1", kinfolkName = "Halbrook Household", client = "Dana Halbrook",
        invoiceNumber = "1029", total = 1234.5, amountDue = 1234.5, status = "sent",
    )
    private fun form(paid: String, apply: String, tip: String = "", fee: String = "", credit: String = "") =
        parseRecordPaymentForm(invoice, paid, apply, tip, fee, "cash", "", "", "", credit, false)
    @Test
    fun normalizeStripsADollarSignAndRealThousandsCommas() {
        assertEquals("1234.50", normalizeMoneyText("1234.50"))
        assertEquals("1234.50", normalizeMoneyText("1,234.50"))
        assertEquals("1234.50", normalizeMoneyText("$1,234.50"))
    }
    @Test
    fun normalizeRefusesCommasThatAreNotThousandsGrouping() {
        assertNull(normalizeMoneyText("1,2,3"))
        assertNull(normalizeMoneyText("12,34"))
    }
    @Test
    fun composerAndCreditParsersShareTheRuleAndRefuseBlankAndMisgrouped() {
        for (parse in listOf(::parseDollarsToCents, ::parseCreditDollarsToCents)) {
            assertEquals(123450L, parse("1234.50"))
            assertEquals(123450L, parse("1,234.50"))
            assertEquals(123450L, parse("$1,234.50"))
            assertNull(parse("1,2,3"))
            assertNull(parse(""))
        }
    }
    @Test
    fun recordPaymentReadsPlainGroupedAndDollarPrefixedAmounts() {
        for (typed in listOf("1234.50", "1,234.50", "$1,234.50")) {
            val ready = form(typed, typed, tip = "", fee = "1,000") as RecordPaymentForm.Ready
            assertEquals(1234.5, ready.entry.payment.amount)
            assertEquals(1234.5, ready.entry.applyAmount)
            assertEquals(1000.0, ready.entry.fee)
        }
    }
    @Test
    fun recordPaymentRefusesMisgroupedAndBlankAmounts() {
        assertTrue(form("1,2,3", "1,2,3") is RecordPaymentForm.Invalid)
        assertTrue(form("", "") is RecordPaymentForm.Invalid)
        assertTrue(form("1,234.50", "1,234.50", tip = "1,2,3") is RecordPaymentForm.Invalid)
        assertTrue(form("1,234.50", "1,234.50", fee = "1,2,3") is RecordPaymentForm.Invalid)
        assertTrue(form("1,234.50", "1,234.50", credit = "1,2,3") is RecordPaymentForm.Invalid)
    }
    @Test
    fun theSplitReadsTypedCommas() {
        val split = recordPaymentSplit("$1,500.00", "1,234.50", "", "")
        assertEquals(RecordPaymentSplit.Ok(150000L, 123450L, 26550L, 0L), split)
    }
    @Test
    fun aGroupedDisplayValueReadsBackIntoTheField() {
        val shown = formatUsd(1234.5)
        assertEquals("$1,234.50", shown)
        assertEquals(RecordPaymentSplit.Ok(123450L, 123450L, 0L, 0L), recordPaymentSplit(shown, shown, "", ""))
        assertTrue(form(shown, shown) is RecordPaymentForm.Ready)
    }
}
