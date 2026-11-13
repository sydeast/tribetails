package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.ApplyCreditEntry
import com.tribetails.auntieos.web.data.ApplyCreditOutcome
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.applyAccountCreditPayload
import com.tribetails.auntieos.web.data.decodeApplyCreditOutcome
import com.tribetails.auntieos.web.data.mintApplyCreditIdempotencyKey
import com.tribetails.auntieos.web.data.recordPaymentOutcomeMessage
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1872 (operator ruling 2026-11-11): account credit goes onto an invoice only
 * as an amount the admin types. The words and checks of that block on the
 * desktop console, shared word for word with the web and Android admin.
 */
class InvoiceApplyCreditTextTest {

    private fun ready(text: String, available: Long = 12000L, due: Long? = 10000L) =
        parseApplyCreditAmount(text, available, due)

    @Test
    fun acceptsAnAmountWithinBothLimits() {
        assertEquals(ApplyCreditForm.Ready(2500L), ready("25.00"))
        assertEquals(ApplyCreditForm.Ready(2500L), ready("25"))
        assertEquals(ApplyCreditForm.Ready(10000L), ready("100.00"))
        assertEquals(ApplyCreditForm.Ready(5000L), ready("50.00", available = 5000L))
    }

    @Test
    fun refusesABlankBoxTextAndANegativeAmount() {
        for (raw in listOf("", "   ", "abc", "12.345", "-5")) {
            assertEquals(ApplyCreditForm.Invalid("Enter an amount in dollars, like 25.00."), ready(raw), raw)
        }
    }

    @Test
    fun refusesZero() {
        assertEquals(ApplyCreditForm.Invalid("Enter an amount above \$0.00."), ready("0"))
        assertEquals(ApplyCreditForm.Invalid("Enter an amount above \$0.00."), ready("0.00"))
    }

    @Test
    fun refusesMoreThanTheHouseholdHolds() {
        assertEquals(
            ApplyCreditForm.Invalid("This household has \$20.00 of account credit. Enter that much or less."),
            ready("20.01", available = 2000L),
        )
    }

    @Test
    fun refusesMoreThanTheInvoiceOwes() {
        assertEquals(
            ApplyCreditForm.Invalid("This invoice has \$100.00 left to pay. Enter that much or less."),
            ready("100.01"),
        )
    }

    @Test
    fun leavesTheInvoiceLimitToTheServerWhenTheBalanceCouldNotBeRead() {
        assertEquals(ApplyCreditForm.Ready(11000L), ready("110.00", due = null))
    }

    @Test
    fun namesTheInvoiceByItsNumberNeverByAStoredId() {
        assertEquals("invoice 1026", applyCreditInvoiceWords("1026"))
        assertEquals("this invoice", applyCreditInvoiceWords(""))
        assertEquals("this invoice", applyCreditInvoiceWords(null))
    }

    @Test
    fun theConfirmationStatesTheAmountTheInvoiceAndBothBalances() {
        assertEquals(
            "Apply \$25.00 of account credit to invoice 1026? The invoice will have \$75.00 left to pay. " +
                "The household keeps \$95.00 of credit.",
            applyCreditConfirmText(2500L, "1026", 12000L, 10000L),
        )
        assertEquals(
            "Apply \$100.00 of account credit to invoice 1026? The invoice will be paid. " +
                "The household keeps \$20.00 of credit.",
            applyCreditConfirmText(10000L, "1026", 12000L, 10000L),
        )
        assertEquals(
            "Apply \$25.00 of account credit to this invoice? The household keeps \$95.00 of credit.",
            applyCreditConfirmText(2500L, "", 12000L, null),
        )
    }

    @Test
    fun theNoticeAfterwardsRepeatsTheServerFigures() {
        val part = ApplyCreditOutcome("inv1", "acr_1_k", 2500L, 7500L, 9500L, false)
        assertEquals(
            "Applied \$25.00 of account credit to invoice 1026. \$75.00 is left to pay. " +
                "The household has \$95.00 of credit left.",
            applyCreditDoneText(part, "1026"),
        )
        val whole = ApplyCreditOutcome("inv1", "acr_1_k", 10000L, 0L, 2000L, false)
        assertEquals(
            "Applied \$100.00 of account credit to invoice 1026. The invoice is paid. " +
                "The household has \$20.00 of credit left.",
            applyCreditDoneText(whole, "1026"),
        )
    }

    @Test
    fun saysWhatIsAvailableOrThatThereIsNone() {
        assertEquals("\$12.00 available", applyCreditAvailableText(1200L))
        assertEquals("This household has no account credit.", applyCreditAvailableText(0L))
    }

    // ── where the block is offered ──────────────────────────────────────────

    private fun invoice(status: String, archived: Boolean = false, kinfolkId: String = "kf1") = Invoice(
        _id = "inv1",
        kinfolkId = kinfolkId,
        status = status,
        amountDue = 40.0,
        archivedAt = if (archived) JsonPrimitive("2026-11-06T09:00:00Z") else null,
    )

    private fun offered(inv: Invoice) = offersApplyCredit(inv, invoiceActionsFor(invoiceStateOrNull(inv)))

    @Test
    fun anOpenInvoiceOffersTheBlock() {
        assertTrue(offered(invoice("open")))
    }

    @Test
    fun aDraftAQuoteAPaidAndACancelledInvoiceDoNot() {
        for (status in listOf("draft", "quote", "paid", "cancelled", "credit")) {
            assertFalse(offered(invoice(status)), status)
        }
    }

    @Test
    fun anArchivedInvoiceDoesNotEvenWhileOpenAndOwed() {
        assertFalse(offered(invoice("open", archived = true)))
        // A stored null is not archived.
        assertTrue(offered(invoice("open").copy(archivedAt = JsonNull)))
    }

    @Test
    fun anInvoiceWithNoHouseholdDoesNot() {
        assertFalse(offered(invoice("open", kinfolkId = "")))
    }

    // ── the wire ────────────────────────────────────────────────────────────

    @Test
    fun thePayloadIsTheInvoiceIntegerCentsAndTheKey() {
        val p = applyAccountCreditPayload(ApplyCreditEntry("inv1", 2500L), "acr_1790000000000_abc123")
        assertEquals(setOf("invoiceId", "amountCents", "idempotencyKey"), p.keys)
        assertEquals("inv1", p["invoiceId"]!!.jsonPrimitive.content)
        assertEquals(2500L, p["amountCents"]!!.jsonPrimitive.long)
        assertEquals("acr_1790000000000_abc123", p["idempotencyKey"]!!.jsonPrimitive.content)
    }

    @Test
    fun theKeyHasTheShapeTheServerRequires() {
        assertTrue(Regex("^acr_[0-9]{10,16}_[a-z0-9]{1,16}$").matches(mintApplyCreditIdempotencyKey()))
    }

    @Test
    fun decodesTheServerFiguresAndIgnoresFieldsItDoesNotKnow() {
        val o = decodeApplyCreditOutcome(
            """{"ok":true,"invoiceId":"inv1","paymentId":"acr_1_k","appliedCents":2500,"amountDueCents":7500,"accountBalanceCents":9500,"replayed":true,"later":1}""",
        )
        assertEquals(ApplyCreditOutcome("inv1", "acr_1_k", 2500L, 7500L, 9500L, true), o)
    }

    @Test
    fun anAnswerMissingThePaymentOrAFigureIsNotAnAppliedCredit() {
        for (body in listOf(
            """{"ok":false,"paymentId":"p","appliedCents":1,"amountDueCents":1,"accountBalanceCents":1}""",
            """{"ok":true,"appliedCents":1,"amountDueCents":1,"accountBalanceCents":1}""",
            """{"ok":true,"paymentId":"p","amountDueCents":1,"accountBalanceCents":1}""",
            """{"ok":true,"paymentId":"p","appliedCents":1,"accountBalanceCents":1}""",
            """{"ok":true,"paymentId":"p","appliedCents":1,"amountDueCents":1}""",
        )) {
            assertFailsWith<IllegalArgumentException>(body) { decodeApplyCreditOutcome(body) }
        }
    }

    // ── words that used to promise an automatic spend ───────────────────────

    @Test
    fun reviewAndSendSaysOnlyWhatItDoes() {
        val words = sendConfirmBodyText(HouseholdSend.REVIEW_SEND)
        assertEquals(
            "This sends the draft to the household and marks the invoice open. A draft missing its " +
                "total, household, or invoice number is rejected rather than sent.",
            words,
        )
        assertFalse(Regex("credit|paid|payment", RegexOption.IGNORE_CASE).containsMatchIn(words))
    }

    @Test
    fun aLeftoverHeldAsCreditIsNotPromisedToAnyInvoice() {
        val words = recordPaymentOutcomeMessage(
            com.tribetails.auntieos.web.data.RecordPaymentOutcome(
                paymentId = "p1",
                invoiceState = "settled",
                amountDueCents = 0L,
                overpaidCents = 0L,
                creditedToAccountCents = 2500L,
                confirmationEmailSent = false,
                householdNoPortalAccount = false,
                officeNoticePending = false,
            ),
            confirmationRequested = false,
        )
        assertTrue(
            words.endsWith(
                " \$25.00 has been added to the household's account credit. It stays there until you apply an amount to an invoice.",
            ),
            words,
        )
        assertFalse(Regex("automatically|next invoice", RegexOption.IGNORE_CASE).containsMatchIn(words))
    }
}
