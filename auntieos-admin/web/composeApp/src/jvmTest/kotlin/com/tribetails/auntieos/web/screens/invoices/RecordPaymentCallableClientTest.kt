package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.InvoicePaymentEntry
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.PaymentSubmissionKeys
import com.tribetails.auntieos.web.data.RecordPaymentOutcome
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.decodeRecordPaymentOutcome
import com.tribetails.auntieos.web.data.recordPaymentOutcomeMessage
import com.tribetails.auntieos.web.data.recordPaymentRefusalText
import com.tribetails.auntieos.web.data.submitInvoicePayment
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #881: the desktop Record Payment dialog goes through the `recordPayment`
 * callable with an `apply`, not the direct REST write.
 *
 * Runs against the jvm `platformInvokeCallable`, which records every
 * (name, payload) in [JvmFirestoreFixtures.callablePayloads] and answers from
 * `callableResponses` / `callableErrors`, so what these tests read is the exact
 * JSON the desktop would send.
 */
class RecordPaymentCallableClientTest {

    @BeforeTest
    fun setUp() = JvmFirestoreFixtures.clear()

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val invoice = Invoice(
        _id = "inv1",
        kinfolkId = "kf1",
        kinfolkName = "Halbrook Household",
        client = "Dana Halbrook",
        invoiceNumber = "1029",
        total = 127.5,
        amountDue = 127.5,
        status = "sent",
    )

    private fun entry(
        amountPaid: String = "137.50",
        apply: String = "127.50",
        tip: String = "10",
        fee: String = "2.71",
        credit: String = "",
        sendConfirmation: Boolean = true,
    ): InvoicePaymentEntry {
        val form = parseRecordPaymentForm(
            invoice, amountPaid, apply, tip, fee, "Venmo", "ref-9", "2026-09-27", " staff note ", credit, sendConfirmation,
        )
        return (form as RecordPaymentForm.Ready).entry
    }

    private val okBody = """
        {"ok":true,"paymentId":"pay_1","kinfolkId":"kf1","amountCents":13750,"tipCents":1000,"feeCents":271,
         "tipBasis":"gross","appliedCents":12750,"unappliedCents":0,"proceedsCents":13479,"tipNetCents":729,
         "autoApply":false,
         "application":{"invoiceId":"inv1","invoiceNumber":"1029","paymentId":"ip1","appliedCents":12750,
           "state":"settled","totalCents":12750,"paidCents":12750,"amountDueCents":0,"overpaidCents":0},
         "creditedToAccountCents":0,"confirmationEmailSent":true,"householdNoPortalAccount":false,"officeNoticePending":false}
    """.trimIndent()

    private fun sent(): List<JsonObject> =
        JvmFirestoreFixtures.callablePayloads.map { (name, json) ->
            assertEquals("recordPayment", name)
            Json.parseToJsonElement(json).jsonObject
        }

    // ── The payload ─────────────────────────────────────────────────────────

    @Test
    fun theDialogCallsRecordPaymentWithAnApplyAKeyAndTheConfirmationTick() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("recordPayment" to okBody)
        // #988: $147.50 paid, $127.50 applied, $10 tip, and she leaves $10 as credit.
        val r = submitInvoicePayment(FirestoreClient(), entry(amountPaid = "147.50", credit = "10"), PaymentSubmissionKeys())
        assertTrue(r is WriteResult.Ok, "$r")

        val p = sent().single()
        // The whole sum the client paid, gross tip included, with the fee beside it.
        assertEquals(147.5, p["amount"]!!.jsonPrimitive.double)
        assertEquals(1000L, p["creditToAccountCents"]!!.jsonPrimitive.long)
        assertEquals(10.0, p["tip"]!!.jsonPrimitive.double)
        assertEquals(2.71, p["fee"]!!.jsonPrimitive.double)
        // One payment, one invoice: a single apply object for THIS invoice.
        val apply = p["apply"]!!.jsonObject
        assertEquals("inv1", apply["invoiceId"]!!.jsonPrimitive.content)
        assertEquals("1029", apply["invoiceNumber"]!!.jsonPrimitive.content)
        assertEquals(127.5, apply["amount"]!!.jsonPrimitive.double)
        assertEquals("inv1", p["invoiceId"]!!.jsonPrimitive.content)
        assertEquals("kf1", p["kinfolkId"]!!.jsonPrimitive.content)
        assertEquals("Dana Halbrook", p["client"]!!.jsonPrimitive.content)
        assertEquals("Venmo", p["paymentMethod"]!!.jsonPrimitive.content)
        assertEquals("ref-9", p["referenceNumber"]!!.jsonPrimitive.content)
        assertEquals("staff note", p["notes"]!!.jsonPrimitive.content)
        assertTrue(p["autoApply"]!!.jsonPrimitive.boolean)
        assertTrue(p["sendConfirmationEmail"]!!.jsonPrimitive.boolean)
        assertTrue(p["idempotencyKey"]!!.jsonPrimitive.content.startsWith("pay_"))
        // Not the two-step flow: no markInvoicePaid settlement is being claimed.
        assertFalse("settledByInvoicePaymentId" in p)
    }

    @Test
    fun theConfirmationAndAutoApplySwitchesAreSentOffWhenLeftOff() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("recordPayment" to okBody)
        submitInvoicePayment(FirestoreClient(), entry(sendConfirmation = false), PaymentSubmissionKeys())
        val p = sent().single()
        assertFalse(p["autoApply"]!!.jsonPrimitive.boolean)
        assertEquals(0L, p["creditToAccountCents"]!!.jsonPrimitive.long)
        assertFalse(p["sendConfirmationEmail"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun theDialogNoLongerWritesThePaymentsRowOverRest() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("recordPayment" to okBody)
        submitInvoicePayment(FirestoreClient(), entry(), PaymentSubmissionKeys())
        assertNull(JvmFirestoreFixtures.lastWrite, "no direct REST write may happen")
        assertEquals(1, JvmFirestoreFixtures.callablePayloads.size)
    }

    // ── Refusals ────────────────────────────────────────────────────────────

    @Test
    fun aRefusalComesBackAsAnErrWithTheServersMessageVerbatim() = runBlocking {
        val refusal = "Invoice 1029 is a draft or quote; send it before applying a payment to it."
        JvmFirestoreFixtures.callableErrors = mapOf("recordPayment" to refusal)
        val r = submitInvoicePayment(FirestoreClient(), entry(), PaymentSubmissionKeys())
        assertTrue(r is WriteResult.Err, "$r")
        val shown = recordPaymentRefusalText((r as WriteResult.Err).message)
        assertTrue(shown.contains(refusal), shown)
        assertTrue(shown.startsWith("Couldn't record payment"), shown)
    }

    @Test
    fun anAnswerWithNoPaymentIdIsAnErrNotASuccess() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("recordPayment" to """{"ok":true}""")
        val r = submitInvoicePayment(FirestoreClient(), entry(), PaymentSubmissionKeys())
        assertTrue(r is WriteResult.Err, "$r")
    }

    // ── The key ─────────────────────────────────────────────────────────────

    @Test
    fun aRePressAfterAFailureReusesTheSameKey() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("recordPayment" to "INTERNAL")
        val keys = PaymentSubmissionKeys()
        val client = FirestoreClient()
        submitInvoicePayment(client, entry(), keys)
        submitInvoicePayment(client, entry(), keys)
        val sentKeys = sent().map { it["idempotencyKey"]!!.jsonPrimitive.content }
        assertEquals(2, sentKeys.size)
        assertEquals(sentKeys[0], sentKeys[1], "a retry of the same payment must carry the same key")
    }

    @Test
    fun aChangedEntryMintsANewKey() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("recordPayment" to "INTERNAL")
        val keys = PaymentSubmissionKeys()
        val client = FirestoreClient()
        submitInvoicePayment(client, entry(), keys)
        submitInvoicePayment(client, entry(fee = "3.10"), keys)
        val sentKeys = sent().map { it["idempotencyKey"]!!.jsonPrimitive.content }
        assertNotEquals(sentKeys[0], sentKeys[1])
    }

    @Test
    fun theKeyIsReleasedOnceTheServerSaysOk() = runBlocking {
        // Two equal cash instalments on one day are two payments, not a replay.
        JvmFirestoreFixtures.callableResponses = mapOf("recordPayment" to okBody)
        val keys = PaymentSubmissionKeys()
        val client = FirestoreClient()
        submitInvoicePayment(client, entry(), keys)
        submitInvoicePayment(client, entry(), keys)
        val sentKeys = sent().map { it["idempotencyKey"]!!.jsonPrimitive.content }
        assertNotEquals(sentKeys[0], sentKeys[1])
    }

    // ── What the operator is told ──────────────────────────────────────────

    private fun outcome(
        state: String = "settled",
        due: Long = 0,
        over: Long = 0,
        credited: Long = 0,
        sent: Boolean = true,
        noPortal: Boolean = false,
        officePending: Boolean = false,
    ) = RecordPaymentOutcome("pay_1", state, due, over, credited, sent, noPortal, officePending)

    @Test
    fun theDecodedOkIsWhatTheToastReports() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("recordPayment" to okBody)
        val r = submitInvoicePayment(FirestoreClient(), entry(), PaymentSubmissionKeys()) as WriteResult.Ok
        assertEquals("settled", r.value.invoiceState)
        assertEquals("Payment recorded. The invoice is paid in full.", recordPaymentOutcomeMessage(r.value, true))
    }

    @Test
    fun aPartialPaymentSaysWhatIsStillOwed() {
        val m = recordPaymentOutcomeMessage(outcome(state = "partial", due = 2750), false)
        assertEquals("Partial payment recorded. $27.50 is still owed, and the invoice stays open.", m)
    }

    @Test
    fun anOverpaymentSaysByHowMuch() {
        val m = recordPaymentOutcomeMessage(outcome(state = "overpaid", over = 500), false)
        assertTrue(m.contains("overpaid by $5.00"), m)
    }

    @Test
    fun aConfirmationThatDidNotGoOutIsSaidAndWhy() {
        assertTrue(
            recordPaymentOutcomeMessage(outcome(sent = false, noPortal = true), true)
                .contains("did not go out: the household has no portal account"),
        )
        assertTrue(
            recordPaymentOutcomeMessage(outcome(sent = false), true)
                .contains("Let the household know another way"),
        )
        // Not asked for, so nothing is said.
        assertEquals(
            "Payment recorded. The invoice is paid in full.",
            recordPaymentOutcomeMessage(outcome(sent = false), false),
        )
    }

    @Test
    fun aConfirmationThatReachedTheHouseholdInTheAppOnlyIsSaidSoNeverAsDidNotGoOut() {
        // #1511
        val appOnly = outcome(sent = false).copy(confirmationAppOnly = true)
        val m = recordPaymentOutcomeMessage(appOnly, true)
        assertEquals(
            "Payment recorded. The invoice is paid in full. The confirmation reached the household in the app only. " +
                "Email and text are off for this household.",
            m,
        )
        // Not asked for, so nothing is said, whatever the flag says.
        assertEquals("Payment recorded. The invoice is paid in full.", recordPaymentOutcomeMessage(appOnly, false))
    }

    @Test
    fun theAppOnlyFlagDecodesAndOnlyAnExplicitTrue() {
        // #1511
        val body = """{"ok":true,"paymentId":"pay_1","confirmationEmailSent":false,"confirmationAppOnly":true}"""
        assertEquals(true, decodeRecordPaymentOutcome(body).confirmationAppOnly)
        assertEquals(false, decodeRecordPaymentOutcome(okBody).confirmationAppOnly)
    }

    @Test
    fun aPendingOfficeCopyAndACreditAreBothReported() {
        val m = recordPaymentOutcomeMessage(outcome(officePending = true, credited = 1200), false)
        assertTrue(m.contains("office copy"), m)
        assertTrue(m.contains("$12.00 has been added to the household's account credit. It stays there until you apply an amount to an invoice."), m)
    }

    // ── The form ────────────────────────────────────────────────────────────

    @Test
    fun aBlankFeeIsZeroAndABlankTipTakesTheRestOfThePayment() {
        // #988: $137.50 paid, $127.50 applied: the $10 left over is tip by default.
        val e = entry(tip = "", fee = "")
        assertEquals(10.0, e.payment.tip)
        assertEquals(0.0, e.fee)
        assertEquals(0L, e.creditToAccountCents)
    }

    @Test
    fun anExactPaymentWithABlankTipHasNoTip() {
        val e = entry(amountPaid = "127.50", tip = "", fee = "")
        assertEquals(0.0, e.payment.tip)
    }

    @Test
    fun creditSheEntersComesOutOfTheTip() {
        // $200 paid, $127.50 applied, $20 credit: the tip is the other $52.50.
        val e = entry(amountPaid = "200", tip = "", credit = "20")
        assertEquals(52.5, e.payment.tip)
        assertEquals(2000L, e.creditToAccountCents)
        assertEquals(200.0, e.payment.amount)
    }

    @Test
    fun aCreditLargerThanTheLeftoverIsRefused() {
        val form = parseRecordPaymentForm(
            invoice, "200", "127.50", "", "", "cash", "", "", "", "72.51", false,
        )
        assertTrue(form is RecordPaymentForm.Invalid)
        assertTrue((form as RecordPaymentForm.Invalid).message.contains("more than the $72.50 left"), form.message)
    }

    @Test
    fun aTypedTipAndCreditThatDoNotAddUpAreRefused() {
        val form = parseRecordPaymentForm(
            invoice, "200", "127.50", "10", "", "cash", "", "", "", "20", false,
        )
        assertTrue(form is RecordPaymentForm.Invalid)
        assertTrue(
            (form as RecordPaymentForm.Invalid).message.contains("add up to $157.50, not the $200.00 paid"),
            form.message,
        )
    }

    @Test
    fun anUnreadableCreditIsRefusedNotDropped() {
        val form = parseRecordPaymentForm(
            invoice, "200", "127.50", "", "", "cash", "", "", "", "lots", false,
        )
        assertTrue(form is RecordPaymentForm.Invalid)
        assertTrue((form as RecordPaymentForm.Invalid).message.contains("is not an amount of account credit"))
    }

    @Test
    fun theSplitLineSaysWhereEveryDollarGoes() {
        assertEquals(
            "$200.00 paid: $127.50 to this invoice, $52.50 tip (the $2.71 fee comes out of it), $20.00 account credit.",
            recordPaymentSplitLine(recordPaymentSplit("200", "127.50", "", "20"), "2.71"),
        )
        assertEquals(
            "$127.50 paid: $127.50 to this invoice, $0.00 tip, $0.00 account credit.",
            recordPaymentSplitLine(recordPaymentSplit("127.50", "127.50", "", ""), ""),
        )
        assertTrue(recordPaymentSplitLine(recordPaymentSplit("abc", "127.50", "", ""), "").contains("cannot be read"))
    }
    /**
     * #1488: the record-payment dialog seeds its amount fields from the amount
     * due. `formatMoney` now prints "$1,234.50", and `recordPaymentSplit` reads
     * no comma, so the seed is the ungrouped input form and a four-figure
     * invoice still opens with a readable split.
     */
    @Test
    fun aFourFigureAmountDueSeedsAReadableSplit() {
        val seed = centsToInputDollars(com.tribetails.auntieos.web.util.dollarsToRoundedCents(1234.5))
        assertEquals("1234.50", seed)
        assertEquals(
            "$1,234.50 paid: $1,234.50 to this invoice, $0.00 tip, $0.00 account credit.",
            recordPaymentSplitLine(recordPaymentSplit(seed, seed, "", ""), ""),
        )
    }

    @Test
    fun anApplyPlusTipLargerThanThePaymentIsRefusedBeforeTheCall() {
        val form = parseRecordPaymentForm(
            invoice, "100", "95", "10", "", "cash", "", "", "", "", false,
        )
        assertTrue(form is RecordPaymentForm.Invalid)
        assertTrue((form as RecordPaymentForm.Invalid).message.contains("does not cover"), form.message)
    }

    @Test
    fun anUnreadableFeeIsRefusedNotDropped() {
        val form = parseRecordPaymentForm(
            invoice, "100", "90", "", "two", "cash", "", "", "", "", false,
        )
        assertTrue(form is RecordPaymentForm.Invalid)
        assertTrue((form as RecordPaymentForm.Invalid).message.contains("is not a fee"))
    }

    // ── #1566: an Apply figure over the balance is tip, never applied ──────
    // The walk: $78.50 owed, $100 applied, fee $2.
    private val owes7850 = invoice.copy(total = 78.5, amountDue = 78.5)
    @Test
    fun overBalanceApplyIsCappedAndTheRestIsTip() {
        assertEquals(
            RecordPaymentSplit.Ok(paidCents = 10_000L, appliedCents = 7_850L, tipCents = 2_150L, creditCents = 0L, overCents = 2_150L),
            recordPaymentSplit("100", "100", "", "", amountDueCents = 7_850L),
        )
    }
    @Test
    fun overBalanceTypedTipIsAddedToTheOverPart() {
        val split = recordPaymentSplit("105", "100", "5", "", amountDueCents = 7_850L) as RecordPaymentSplit.Ok
        assertEquals(7_850L, split.appliedCents)
        assertEquals(2_650L, split.tipCents)
    }
    @Test
    fun overBalanceCreditComesOutOfTheOverPart() {
        val split = recordPaymentSplit("100", "100", "", "10", amountDueCents = 7_850L) as RecordPaymentSplit.Ok
        assertEquals(7_850L, split.appliedCents)
        assertEquals(1_150L, split.tipCents)
        assertEquals(1_000L, split.creditCents)
    }
    @Test
    fun overBalanceTypedTipThatNoLongerFitsIsRefusedAndSaysWhy() {
        val split = recordPaymentSplit("100", "100", "21.50", "", amountDueCents = 7_850L) as RecordPaymentSplit.Refused
        assertTrue(split.message.contains("does not cover \$78.50 applied plus a \$43.00 tip"), split.message)
        assertTrue(split.message.contains("The invoice owes \$78.50, so \$21.50 of the amount applied counts as tip."), split.message)
    }
    @Test
    fun exactlyTheBalanceIsUnchanged() {
        assertEquals(
            RecordPaymentSplit.Ok(7_850L, 7_850L, 0L, 0L),
            recordPaymentSplit("78.50", "78.50", "", "", amountDueCents = 7_850L),
        )
    }
    @Test
    fun aZeroAmountDueIsNotTrustedAndCapsNothing() {
        assertEquals(null, invoiceBalanceCents(invoice.copy(amountDue = 0.0)))
        assertEquals(7_850L, invoiceBalanceCents(owes7850))
        val split = recordPaymentSplit("100", "100", "", "", amountDueCents = null) as RecordPaymentSplit.Ok
        assertEquals(10_000L, split.appliedCents)
    }
    @Test
    fun anInvoiceThatOwesNothingTakesNoPayment() {
        assertEquals(
            RecordPaymentSplit.Refused("This invoice owes nothing, so no payment can be recorded against it."),
            recordPaymentSplit("100", "100", "", "", amountDueCents = 0L),
        )
    }
    @Test
    fun overBalanceSplitLineSaysTheInvoiceTakesTheBalanceAndTheRestIsTip() {
        assertEquals(
            "\$100.00 paid: \$78.50 to this invoice, \$21.50 tip (the \$2.00 fee comes out of it), \$0.00 account credit. " +
                "The invoice owes \$78.50, so the \$21.50 over it is tip.",
            recordPaymentSplitLine(recordPaymentSplit("100", "100", "", "", invoiceBalanceCents(owes7850)), "2"),
        )
    }
    @Test
    fun overBalanceFormSendsTheBalanceAsApplyAndTheRestAsTip() {
        val form = parseRecordPaymentForm(
            owes7850, "100", "100", "", "2", "Venmo", "", "2026-11-05", "", "", false,
        )
        val e = (form as RecordPaymentForm.Ready).entry
        assertEquals(78.5, e.applyAmount)
        assertEquals(21.5, e.payment.tip)
        assertEquals(100.0, e.payment.amount)
        assertEquals(2.0, e.fee)
        assertEquals(0L, e.creditToAccountCents)
    }
}
