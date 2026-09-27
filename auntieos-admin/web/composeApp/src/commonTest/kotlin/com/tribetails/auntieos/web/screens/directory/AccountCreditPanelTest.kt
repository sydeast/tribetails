package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.CreditApplicationDto
import com.tribetails.auntieos.web.data.CreditUseDto
import com.tribetails.auntieos.web.data.GiveCreditEntry
import com.tribetails.auntieos.web.data.GivenCreditDto
import com.tribetails.auntieos.web.data.decodeAccountCreditHistory
import com.tribetails.auntieos.web.data.decodeGiveCreditOutcome
import com.tribetails.auntieos.web.data.giveAccountCreditPayload
import com.tribetails.auntieos.web.data.isCreditHistoryRefusal
import com.tribetails.auntieos.web.data.mintGiveCreditIdempotencyKey
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Q6: the desktop Give credit form rules and the history text, pure. */
class AccountCreditPanelTest {

    private val utc = TimeZone.UTC

    // 2026-09-27T12:00:00Z and 2026-10-03T12:00:00Z
    private val sep27 = 1790510400000L
    private val oct3 = 1791028800000L

    private fun invalid(amount: String, reason: String = "Missed visit"): String =
        (parseGiveCreditForm("kf1", amount, reason) as GiveCreditForm.Invalid).message

    @Test
    fun aPlainAmountAndAReasonAreReady() {
        assertEquals(
            GiveCreditForm.Ready(GiveCreditEntry("kf1", 2500, "Missed visit")),
            parseGiveCreditForm("kf1", "25", "  Missed visit  "),
        )
        assertEquals(2550L, (parseGiveCreditForm("kf1", "$25.5", "r") as GiveCreditForm.Ready).entry.amountCents)
        assertEquals(100_000L, (parseGiveCreditForm("kf1", "1,000.00", "r") as GiveCreditForm.Ready).entry.amountCents)
    }

    @Test
    fun theAmountIsRefusedWhenBlankZeroNegativeOrMalformed() {
        assertEquals("Enter an amount.", invalid("  "))
        assertEquals("The amount has to be more than \$0.00.", invalid("0"))
        assertEquals("The amount has to be more than \$0.00.", invalid("0.00"))
        assertEquals("The amount has to be more than \$0.00.", invalid("-5"))
        assertEquals("Enter the amount in dollars, like 25.00.", invalid("25.001"))
        assertEquals("Enter the amount in dollars, like 25.00.", invalid("twenty"))
    }

    @Test
    fun theCapIsFiveThousandDollars() {
        assertTrue(parseGiveCreditForm("kf1", "5000.00", "r") is GiveCreditForm.Ready)
        assertEquals("One credit can be at most \$5,000.00.", invalid("5000.01"))
    }

    @Test
    fun theReasonIsRequiredAndBounded() {
        assertEquals("Enter a reason.", invalid("25", "   "))
        assertTrue(parseGiveCreditForm("kf1", "25", "x".repeat(1000)) is GiveCreditForm.Ready)
        assertEquals("The reason can be at most 1,000 characters.", invalid("25", "x".repeat(1001)))
    }

    @Test
    fun theConfirmationShowsTheBalanceBeforeAndAfter() {
        assertEquals("Give \$25.00 credit? Balance goes from \$12.00 to \$37.00.", giveCreditConfirmText(2500, 1200))
        assertEquals("Credit given. Balance is now \$37.00.", giveCreditSuccessText(3700))
        assertEquals("\$12.00 on account", creditBalanceLine(1200))
        assertEquals("-\$5.00 on account", creditBalanceLine(-500))
    }

    private fun credit(
        amount: Long = 2500,
        remaining: Long = 2500,
        fully: Long? = null,
        apps: List<CreditApplicationDto> = emptyList(),
    ) = GivenCreditDto("c1", amount, "Missed visit", sep27, remaining, fully, apps)

    @Test
    fun theStatusLineSaysWhenTheCreditWasApplied() {
        assertEquals("Given Sep 27, 2026", givenCreditDateLine(credit(), utc))
        assertEquals("Not used yet", givenCreditStatusLine(credit(), utc))
        assertEquals(
            "Applied Oct 3, 2026",
            givenCreditStatusLine(
                credit(remaining = 0, fully = oct3, apps = listOf(CreditApplicationDto(oct3, 2500, "inv9", "INV-1009"))),
                utc,
            ),
        )
        assertEquals(
            "\$10.00 of \$25.00 applied: Sep 27, 2026, Oct 3, 2026",
            givenCreditStatusLine(
                credit(
                    remaining = 1500,
                    apps = listOf(
                        CreditApplicationDto(sep27, 500, "inv8", null),
                        CreditApplicationDto(oct3, 500, "inv9", "INV-1009"),
                    ),
                ),
                utc,
            ),
        )
    }

    @Test
    fun aUseNamesItsInvoiceOrSaysAnInvoice() {
        assertEquals("\$25.00 on INV-1009, Oct 3, 2026", creditUseLine(CreditUseDto("d1", oct3, 2500, "inv9", "INV-1009"), utc))
        assertEquals("\$25.00 on an invoice, Oct 3, 2026", creditUseLine(CreditUseDto("d1", oct3, 2500, "inv9", null), utc))
        assertEquals("\$25.00 on an invoice, Oct 3, 2026", creditUseLine(CreditUseDto("d1", oct3, 2500, "inv9", ""), utc))
    }

    @Test
    fun thePayloadAndDecodersFollowTheServerShape() {
        val p = giveAccountCreditPayload(GiveCreditEntry("kf1", 2500, "r"), "kf1", "crd_1_k")
        assertEquals(setOf("kinfolkId", "amountCents", "reason", "idempotencyKey"), p.keys)
        val o = decodeGiveCreditOutcome("""{"ok":true,"creditId":"c1","amountCents":2500,"newAccountBalanceCents":-100,"replayed":true,"x":0}""")
        assertEquals(-100L, o.newAccountBalanceCents)
        assertTrue(o.replayed)
        assertFailsWith<IllegalArgumentException> { decodeGiveCreditOutcome("""{"ok":true}""") }
        val empty = decodeAccountCreditHistory("""{"ok":true,"kinfolkId":"kf1","accountBalanceCents":0}""")
        assertTrue(empty.credits.isEmpty() && empty.uses.isEmpty())
    }

    @Test
    fun onlyAGateRefusalHidesThePanel() {
        assertTrue(isCreditHistoryRefusal("Billing access is required to see account credit."))
        assertTrue(isCreditHistoryRefusal("permission-denied"))
        assertFalse(isCreditHistoryRefusal("deadline-exceeded"))
        assertFalse(isCreditHistoryRefusal("Household not found."))
    }

    @Test
    fun theKeyUsesTheCreditPrefix() {
        assertTrue(Regex("^crd_[0-9]{10,16}_[a-z0-9]{6}$").matches(mintGiveCreditIdempotencyKey()))
    }
}
