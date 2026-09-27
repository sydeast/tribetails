package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.contracts.GetAccountCreditHistoryResultCredit
import com.tribetails.auntieos.data.contracts.GetAccountCreditHistoryResultCreditApplication
import com.tribetails.auntieos.data.contracts.GetAccountCreditHistoryResultUse
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Test

/** Q6: the Give credit form and the credit history lines, shared wording with web and desktop. */
class AccountCreditTest {

    private val zone = ZoneId.of("America/Chicago")
    private fun ms(y: Int, m: Int, d: Int) = ZonedDateTime.of(y, m, d, 12, 0, 0, 0, zone).toInstant().toEpochMilli()

    @Test
    fun `the form refuses what the server would refuse`() {
        assertEquals(GiveCreditForm.Invalid("Enter an amount."), parseGiveCreditForm("  ", "r"))
        assertEquals(GiveCreditForm.Invalid("Enter an amount in dollars, like 25.00."), parseGiveCreditForm("-5", "r"))
        assertEquals(GiveCreditForm.Invalid("Enter an amount in dollars, like 25.00."), parseGiveCreditForm("12.345", "r"))
        assertEquals(GiveCreditForm.Invalid("Enter an amount in dollars, like 25.00."), parseGiveCreditForm("abc", "r"))
        assertEquals(GiveCreditForm.Invalid("Credit must be more than $0.00."), parseGiveCreditForm("0", "r"))
        assertEquals(GiveCreditForm.Invalid("Credit can be at most $5,000.00."), parseGiveCreditForm("5000.01", "r"))
        assertEquals(GiveCreditForm.Invalid("Enter a reason."), parseGiveCreditForm("25", "   "))
        assertEquals(
            GiveCreditForm.Invalid("Reason can be at most 1,000 characters."),
            parseGiveCreditForm("25", "x".repeat(1001)),
        )
    }

    @Test
    fun `the form reads dollars as integer cents and trims the reason`() {
        assertEquals(GiveCreditForm.Ready(2500L, "Missed visit"), parseGiveCreditForm("$25.00", "  Missed visit "))
        assertEquals(GiveCreditForm.Ready(500_000L, "cap"), parseGiveCreditForm("5,000", "cap"))
        assertEquals(GiveCreditForm.Ready(1L, "r"), parseGiveCreditForm("0.01", "r"))
    }

    @Test
    fun `the confirmation shows the balance before and after, when it is known`() {
        assertEquals("Give $25.00 credit? Balance goes from $12.00 to $37.00.", giveCreditConfirmText(2500L, 1200L))
        assertEquals("Give $25.00 credit?", giveCreditConfirmText(2500L, null))
    }

    @Test
    fun `the success note carries the balance it is given`() {
        assertEquals("Credit given. Balance is now $37.00.", giveCreditSuccessText(3700L))
        assertEquals("$10.00 on account", accountBalanceLine(1000L))
    }

    private fun credit(
        amount: Long,
        remaining: Long,
        fully: Long?,
        apps: List<GetAccountCreditHistoryResultCreditApplication> = emptyList(),
    ) = GetAccountCreditHistoryResultCredit("c", amount, "r", ms(2026, 9, 27), remaining, fully, apps)

    private fun app(amount: Long, at: Long) = GetAccountCreditHistoryResultCreditApplication(at, amount, "inv", null)

    @Test
    fun `status line - not used, partly used, applied`() {
        assertEquals("Given Sep 27, 2026", creditGivenLine(credit(2500, 2500, null), zone))
        assertEquals("Not used yet", creditStatusLine(credit(2500, 2500, null), zone))

        val partly = credit(2500, 1500, null, listOf(app(1000, ms(2026, 9, 28))))
        assertEquals("$10.00 of $25.00 applied", creditStatusLine(partly, zone))
        assertEquals(listOf("$10.00 applied Sep 28, 2026"), creditApplicationLines(partly, zone))

        val done = credit(2500, 0, ms(2026, 10, 3), listOf(app(1000, ms(2026, 9, 28)), app(1500, ms(2026, 10, 3))))
        assertEquals("Applied Oct 3, 2026", creditStatusLine(done, zone))
        assertEquals(emptyList<String>(), creditApplicationLines(done, zone))
    }

    @Test
    fun `a use names its invoice, or says an invoice when it has no number`() {
        val use = GetAccountCreditHistoryResultUse("u", ms(2026, 9, 28), 2500, "inv9", "INV-1009")
        assertEquals("$25.00 on INV-1009, Sep 28, 2026", creditUseLine(use, zone))
        assertEquals("$25.00 on an invoice, Sep 28, 2026", creditUseLine(use.copy(invoiceNumber = null), zone))
    }
}
