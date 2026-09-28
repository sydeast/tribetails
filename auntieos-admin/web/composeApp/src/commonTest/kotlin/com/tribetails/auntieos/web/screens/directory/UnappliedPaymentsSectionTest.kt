package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.OpenInvoiceDto
import com.tribetails.auntieos.web.data.UnappliedDecision
import com.tribetails.auntieos.web.data.UnappliedDecisionOutcome
import com.tribetails.auntieos.web.data.UnappliedDecisionSubmissionKeys
import com.tribetails.auntieos.web.data.UnappliedPaymentDto
import com.tribetails.auntieos.web.data.UnappliedPaymentsList
import com.tribetails.auntieos.web.data.UnappliedPaymentsLoad
import com.tribetails.auntieos.web.data.decodeUnappliedDecisionOutcome
import com.tribetails.auntieos.web.data.decodeUnappliedPaymentsList
import com.tribetails.auntieos.web.data.mintUnappliedDecisionIdempotencyKey
import com.tribetails.auntieos.web.data.resolveUnappliedPaymentPayload
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #1003: the desktop Decide rules, text and payload, pure. */
class UnappliedPaymentsSectionTest {

    private val utc = TimeZone.UTC
    private val sep27 = 1790510400000L // 2026-09-27T12:00:00Z

    private val payment = UnappliedPaymentDto(
        paymentId = "evt_1", kinfolkId = "kf1", invoiceId = "inv42", invoiceNumber = "INV-1042",
        amountCents = 2500, amountResolved = true, feeCents = 103,
        reason = "the invoice was already marked paid", receivedAtMs = sep27, referenceNumber = "pi_1",
    )
    private val inv = OpenInvoiceDto("inv50", "INV-1050", 4000)

    private fun invalid(credit: String, reason: String = "", invoice: OpenInvoiceDto? = null, apply: String = ""): String =
        (parseDecisionForm(payment, credit, reason, invoice, apply) as DecisionForm.Invalid).message

    private fun ready(credit: String, reason: String = "", invoice: OpenInvoiceDto? = null, apply: String = ""): UnappliedDecision =
        (parseDecisionForm(payment, credit, reason, invoice, apply) as DecisionForm.Ready).decision

    // ---- text ----

    @Test
    fun theRowReadsAsTheSpecSays() {
        assertEquals("\$25.00 card payment on invoice INV-1042", unappliedPaymentLine(payment))
        assertEquals(
            "Sep 27, 2026. Not applied because the invoice was already marked paid.",
            unappliedPaymentDetailLine(payment, utc),
        )
        // A reason that already ends in a period does not get a second one.
        assertEquals(
            "Sep 27, 2026. Not applied because the round was stale.",
            unappliedPaymentDetailLine(payment.copy(reason = "the round was stale."), utc),
        )
    }

    @Test
    fun theDialogTextReadsAsTheSpecSays() {
        assertEquals("Decide what this payment becomes", DECIDE_TITLE)
        assertEquals(
            "Card payment of \$25.00 on invoice INV-1042. There are no refunds. " +
                "Anything you do not credit or apply stays recorded on the payment.",
            decideLeadLine(payment),
        )
        assertEquals("INV-1050, \$40.00 due", openInvoiceOptionLabel(inv))
        assertEquals("Credit \$10.00, apply \$15.00, keep \$0.00.", decisionSummaryLine(2500, "10", "15"))
        assertEquals("Credit \$0.00, apply \$0.00, keep \$25.00.", decisionSummaryLine(2500, "", ""))
        assertEquals("No open invoices for this household.", DECIDE_NO_OPEN_INVOICES)
    }

    // ---- client-side refusals ----

    @Test
    fun allZeroIsLegalAndKeepsItAsRecorded() {
        assertEquals(UnappliedDecision("evt_1", 0, "", "", 0), ready(""))
        assertEquals(UnappliedDecision("evt_1", 0, "", "", 0), ready("0", reason = "ignored"))
    }

    @Test
    fun badAmountsAreRefusedFirst() {
        assertEquals("Enter an amount in dollars, like 12.50.", invalid("-1"))
        assertEquals("Enter an amount in dollars, like 12.50.", invalid("1.005"))
        assertEquals("Enter an amount in dollars, like 12.50.", invalid("ten"))
        assertEquals("Enter an amount in dollars, like 12.50.", invalid("", invoice = inv, apply = "-2"))
    }

    @Test
    fun theSumCannotPassThePayment() {
        assertEquals(
            "The credit and the applied amount add up to more than this payment.",
            invalid("20", "r", inv, "5.01"),
        )
        assertTrue(parseDecisionForm(payment, "20", "r", inv, "5") is DecisionForm.Ready)
    }

    @Test
    fun aCreditNeedsAReason() {
        assertEquals("Enter a reason for the credit.", invalid("10", "   "))
    }

    @Test
    fun anAppliedAmountNeedsAnInvoice() {
        assertEquals("Choose an invoice for the applied amount.", invalid("", apply = "5"))
    }

    @Test
    fun theInvoiceCannotBeOverpaid() {
        val small = OpenInvoiceDto("inv9", "INV-9", 1200)
        assertEquals("That invoice owes only \$12.00.", invalid("", invoice = small, apply = "12.01"))
    }

    @Test
    fun anUnresolvedAmountOnlyTakesTheAllZeroDecision() {
        val unresolved = payment.copy(amountCents = 0, amountResolved = false)
        assertTrue(parseDecisionForm(unresolved, "", "", null, "") is DecisionForm.Ready)
        assertEquals(
            "The credit and the applied amount add up to more than this payment.",
            (parseDecisionForm(unresolved, "1", "r", null, "") as DecisionForm.Invalid).message,
        )
    }

    @Test
    fun theDecisionIsBuiltFromTheFieldsTrimmed() {
        assertEquals(
            UnappliedDecision("evt_1", 1000, "Missed visit", "inv50", 1500),
            ready(" 10 ", "  Missed visit  ", inv, "15.00"),
        )
        // An invoice chosen with nothing applied sends no invoice id.
        assertEquals(UnappliedDecision("evt_1", 0, "", "", 0), ready("", "", inv, ""))
    }

    // ---- payload ----

    @Test
    fun thePayloadHasEveryArgAndBlanksWhatIsNotUsed() {
        val p = resolveUnappliedPaymentPayload(UnappliedDecision("evt_1", 0, "left over", "inv50", 0), "upd_1_a")
        assertEquals(
            setOf("paymentId", "creditCents", "creditReason", "applyInvoiceId", "applyCents", "idempotencyKey"),
            p.keys,
        )
        assertEquals("", p["creditReason"]!!.jsonPrimitive.content)
        assertEquals("", p["applyInvoiceId"]!!.jsonPrimitive.content)
        assertEquals(0L, p["creditCents"]!!.jsonPrimitive.long)
        assertEquals(0L, p["applyCents"]!!.jsonPrimitive.long)
        val q = resolveUnappliedPaymentPayload(UnappliedDecision("evt_1", 1000, " why ", "inv50", 1500), "upd_1_a")
        assertEquals("why", q["creditReason"]!!.jsonPrimitive.content)
        assertEquals("inv50", q["applyInvoiceId"]!!.jsonPrimitive.content)
        assertEquals(1500L, q["applyCents"]!!.jsonPrimitive.long)
        assertEquals("upd_1_a", q["idempotencyKey"]!!.jsonPrimitive.content)
    }

    @Test
    fun theKeyHasTheServerShape() {
        val key = mintUnappliedDecisionIdempotencyKey()
        assertTrue(Regex("^upd_\\d+_[a-z0-9]{1,16}$").matches(key), key)
        assertNotEquals(key, mintUnappliedDecisionIdempotencyKey())
    }

    @Test
    fun theKeyIsKeptForTheSameDecisionAndDroppedOnAnEdit() {
        var n = 0
        val keys = UnappliedDecisionSubmissionKeys { "upd_1_k${++n}" }
        val d = UnappliedDecision("evt_1", 1000, "r", "", 0)
        assertEquals("upd_1_k1", keys.keyFor(d))
        assertEquals("upd_1_k1", keys.keyFor(d.copy()))
        assertEquals("upd_1_k2", keys.keyFor(d.copy(creditCents = 900)))
        keys.release()
        assertEquals("upd_1_k3", keys.keyFor(d.copy(creditCents = 900)))
    }

    // ---- busy state ----

    @Test
    fun whileSavingTheLabelChangesAndTheDialogStays() {
        assertEquals("Save decision", decisionSaveLabel(false))
        assertEquals("Saving...", decisionSaveLabel(true))
        assertFalse(decideDialogCanDismiss(true))
        assertTrue(decideDialogCanDismiss(false))
    }

    // ---- result note ----

    private fun outcome(
        credited: Long = 1000, applied: Long = 1500, state: String = "settled", due: Long = 0, kept: Long = 0,
    ) = UnappliedDecisionOutcome(
        paymentId = "evt_1", kinfolkId = "kf1", paymentCents = 2500, creditedCents = credited, creditId = "c1",
        appliedCents = applied, appliedInvoiceId = "inv50", appliedInvoiceNumber = "INV-1050",
        appliedInvoiceState = state, appliedInvoiceAmountDueCents = due, keptCents = kept,
        newAccountBalanceCents = 3700, replayed = false,
    )

    @Test
    fun theResultNoteIsBuiltFromTheServerAnswer() {
        assertEquals(
            "Decision saved. \$10.00 to account credit (balance now \$37.00). " +
                "\$15.00 on invoice INV-1050 (paid in full). \$0.00 kept on the payment.",
            decisionResultText(outcome()),
        )
        assertEquals(
            "Decision saved. \$15.00 on invoice INV-1050 (\$12.00 still due). \$10.00 kept on the payment.",
            decisionResultText(outcome(credited = 0, state = "partial", due = 1200, kept = 1000)),
        )
        assertEquals(
            "Decision saved. \$25.00 kept on the payment.",
            decisionResultText(outcome(credited = 0, applied = 0, kept = 2500)),
        )
    }

    // ---- list view ----

    private fun loaded(vararg p: UnappliedPaymentDto) =
        UnappliedPaymentsLoad.Loaded(UnappliedPaymentsList("kf1", p.toList(), listOf(inv)))

    @Test
    fun theListIsHiddenWhenEmptyUnlessOpenedFromTheNotice() {
        assertEquals(UnappliedSectionView.Hidden, unappliedSectionView(loaded(), openedFromNotice = false))
        assertEquals(UnappliedSectionView.Empty, unappliedSectionView(loaded(), openedFromNotice = true))
        assertEquals("No card payments are waiting for a decision.", UNAPPLIED_EMPTY_FROM_NOTICE)
        assertEquals(UnappliedSectionView.Rows(listOf(payment)), unappliedSectionView(loaded(payment), false))
        assertEquals(UnappliedSectionView.Hidden, unappliedSectionView(null, true))
        assertEquals(UnappliedSectionView.Hidden, unappliedSectionView(UnappliedPaymentsLoad.Hidden, true))
        assertEquals(UnappliedSectionView.Failed, unappliedSectionView(UnappliedPaymentsLoad.Failed("x"), false))
        assertEquals("Could not load payments needing a decision.", UNAPPLIED_LOAD_FAILED)
        assertEquals("Payments needing a decision", UNAPPLIED_TITLE)
    }

    @Test
    fun theNoticeOpensItsPaymentOnlyWhenItIsStillWaiting() {
        assertEquals(payment, paymentToOpenFromNotice(loaded(payment), "evt_1"))
        assertNull(paymentToOpenFromNotice(loaded(payment), "evt_other"))
        assertNull(paymentToOpenFromNotice(loaded(payment), ""))
        assertNull(paymentToOpenFromNotice(null, "evt_1"))
    }

    // ---- decode ----

    @Test
    fun theListDecodesAndIgnoresUnknownKeys() {
        val l = decodeUnappliedPaymentsList(
            """{"ok":true,"kinfolkId":"kf1","extra":1,
               "payments":[{"paymentId":"evt_1","kinfolkId":"kf1","invoiceId":"inv42","invoiceNumber":"INV-1042",
                 "amountCents":2500,"amountResolved":true,"feeCents":103,"reason":"the invoice was already marked paid",
                 "receivedAtMs":$sep27,"referenceNumber":"pi_1","future":"x"}],
               "openInvoices":[{"invoiceId":"inv50","invoiceNumber":"INV-1050","amountDueCents":4000}]}""",
        )
        assertEquals(listOf(payment), l.payments)
        assertEquals(listOf(inv), l.openInvoices)
        assertEquals(0, decodeUnappliedPaymentsList("""{"ok":true}""").payments.size)
    }

    @Test
    fun anAnswerWithoutTheFiguresIsNotASavedDecision() {
        assertFailsWith<IllegalArgumentException> { decodeUnappliedDecisionOutcome("""{"ok":true,"keptCents":0}""") }
        assertFailsWith<IllegalArgumentException> {
            decodeUnappliedDecisionOutcome("""{"ok":true,"paymentId":"evt_1","newAccountBalanceCents":0}""")
        }
    }
}
