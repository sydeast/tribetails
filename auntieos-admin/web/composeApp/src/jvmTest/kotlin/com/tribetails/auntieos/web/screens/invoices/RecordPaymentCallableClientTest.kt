package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.InvoicePaymentEntry
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.PaymentSubmissionKeys
import com.tribetails.auntieos.web.data.RecordPaymentOutcome
import com.tribetails.auntieos.web.data.WriteResult
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
        autoApply: Boolean = false,
        sendConfirmation: Boolean = true,
    ): InvoicePaymentEntry {
        val form = parseRecordPaymentForm(
            invoice, amountPaid, apply, tip, fee, "Venmo", "ref-9", "2026-09-27", " staff note ", autoApply, sendConfirmation,
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
        val r = submitInvoicePayment(FirestoreClient(), entry(autoApply = true), PaymentSubmissionKeys())
        assertTrue(r is WriteResult.Ok, "$r")

        val p = sent().single()
        // The whole sum the client paid, gross tip included, with the fee beside it.
        assertEquals(137.5, p["amount"]!!.jsonPrimitive.double)
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
    fun aPendingOfficeCopyAndACreditAreBothReported() {
        val m = recordPaymentOutcomeMessage(outcome(officePending = true, credited = 1200), false)
        assertTrue(m.contains("office copy"), m)
        assertTrue(m.contains("$12.00 was left over and has been added to the household's account balance"), m)
    }

    // ── The form ────────────────────────────────────────────────────────────

    @Test
    fun blankTipAndFeeAreZero() {
        val e = entry(tip = "", fee = "")
        assertEquals(0.0, e.payment.tip)
        assertEquals(0.0, e.fee)
    }

    @Test
    fun anApplyPlusTipLargerThanThePaymentIsRefusedBeforeTheCall() {
        val form = parseRecordPaymentForm(
            invoice, "100", "95", "10", "", "cash", "", "", "", false, false,
        )
        assertTrue(form is RecordPaymentForm.Invalid)
        assertTrue((form as RecordPaymentForm.Invalid).message.contains("does not cover"), form.message)
    }

    @Test
    fun anUnreadableFeeIsRefusedNotDropped() {
        val form = parseRecordPaymentForm(
            invoice, "100", "90", "", "two", "cash", "", "", "", false, false,
        )
        assertTrue(form is RecordPaymentForm.Invalid)
        assertTrue((form as RecordPaymentForm.Invalid).message.contains("is not a fee"))
    }
}
