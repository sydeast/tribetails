package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.LEDGER_AMOUNT_UNREAD
import com.tribetails.auntieos.web.data.Payment
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.decodeInvoiceLedgerPayments
import com.tribetails.auntieos.web.data.InvoiceLedgerPayment
import com.tribetails.auntieos.web.data.ledgerPaymentAmountLabel
import com.tribetails.auntieos.web.data.ledgerRowAppliedLabel
import com.tribetails.auntieos.web.data.ledgerRowAppliedTo
import com.tribetails.auntieos.web.data.ledgerRowBalanceLabel
import com.tribetails.auntieos.web.data.ledgerRowBalanceNote
import com.tribetails.auntieos.web.data.ledgerRowCaveat
import com.tribetails.auntieos.web.data.ledgerRowDateLabel
import com.tribetails.auntieos.web.data.ledgerRowFeeLabel
import com.tribetails.auntieos.web.data.ledgerRowMethodLabel
import com.tribetails.auntieos.web.data.ledgerRowTipLabel
import com.tribetails.auntieos.web.data.ledgerRowTipNote
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #2333: the desktop invoice Payments list showed a card payment at 100 times
 * its amount and a tipped payment with its tip twice.
 *
 * It read the root `payments` collection itself and printed `amount + tip` as
 * dollars. A card row's `amount` is CENTS when it came off the Stripe event,
 * and a hand-recorded row's `amount` already holds the gross tip. Admin web and
 * Android ask `getInvoiceLedger`, which resolves both on the server; so does
 * the console now. These tests pin the rendered string, because the rendered
 * string is what was wrong.
 */
@OptIn(ExperimentalTestApi::class)
class InvoicePaymentAmountUnitsTest {

    @BeforeTest fun setUp() = JvmFirestoreFixtures.clear()
    @AfterTest fun tearDown() = JvmFirestoreFixtures.clear()

    private fun SemanticsNodeInteractionsProvider.shown(text: String): Boolean =
        onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun row(
        id: String,
        amountCents: Long,
        tipCents: Long = 0,
        feeCents: Long = 0,
        resolved: Boolean = true,
        method: String = "card",
        appliedCents: Long = amountCents - tipCents,
        unappliedCents: Long = amountCents - appliedCents - tipCents,
        tipBasis: String = "gross",
        reconciles: Boolean = true,
        autoApply: Boolean = false,
        appliedNumber: String = "1029",
        date: String = "2026-10-12",
    ) = """
        {"paymentId":"$id","amountCents":$amountCents,"amountResolved":$resolved,"tipCents":$tipCents,
         "feeCents":$feeCents,"tipBasis":"$tipBasis","reconciles":$reconciles,"appliedCents":$appliedCents,
         "unappliedCents":$unappliedCents,"proceedsCents":${amountCents - feeCents},"autoApply":$autoApply,
         "appliedInvoiceId":"${if (appliedNumber.isEmpty()) "" else "inv1"}","appliedInvoiceNumber":"$appliedNumber",
         "method":"$method","reference":"","date":"$date","notes":"","recordedBy":null}
    """.trimIndent()

    private fun ledger(linked: List<String>, unlinked: List<String> = emptyList()) = """
        {"invoiceId":"inv1","payments":[],"paidCents":0,"totalCents":4200,"amountDueCents":0,
         "writeOffs":[],"writtenOffCents":0,
         "ledgerPayments":[${linked.joinToString(",")}],
         "unlinkedKinfolkPayments":[${unlinked.joinToString(",")}],
         "unresolvedAmountCount":0,"sessions":[],"missingSessionIds":[],"orphanSessionIds":[],"truncated":false}
    """.trimIndent()

    // ── The decoder ─────────────────────────────────────────────────────────

    @Test
    fun aCardPaymentOf4200CentsReadsAs42Dollars() {
        val p = decodeInvoiceLedgerPayments(ledger(listOf(row("p1", 4200)))).linked.single()
        assertEquals(4200L, p.amountCents)
        assertEquals("\$42.00", ledgerPaymentAmountLabel(p))
    }

    @Test
    fun aTippedPaymentShowsTheAmountAloneBecauseTheGrossTipIsInsideIt() {
        val p = decodeInvoiceLedgerPayments(ledger(listOf(row("p1", 13750, tipCents = 1000, feeCents = 271)))).linked.single()
        assertEquals(1000L, p.tipCents)
        assertEquals(271L, p.feeCents)
        assertEquals("\$137.50", ledgerPaymentAmountLabel(p), "never amount + tip (\$147.50)")
    }

    @Test
    fun aRowTheServerCouldNotReadGetsNoDollarFigure() {
        val p = decodeInvoiceLedgerPayments(ledger(listOf(row("p1", 0, resolved = false)))).linked.single()
        assertEquals(LEDGER_AMOUNT_UNREAD, ledgerPaymentAmountLabel(p))
    }

    @Test
    fun missingKeysReadAsUnresolvedAndMissingListsAsEmpty() {
        val decoded = decodeInvoiceLedgerPayments(
            """{"ledgerPayments":[{"paymentId":"p1","amountCents":4200}],"somethingNew":1}""",
        )
        val p = decoded.linked.single()
        assertFalse(p.amountResolved, "an absent amountResolved is not a resolved figure")
        assertEquals(LEDGER_AMOUNT_UNREAD, ledgerPaymentAmountLabel(p))
        assertTrue(decoded.unlinkedKinfolk.isEmpty())
        assertTrue(decodeInvoiceLedgerPayments("{}").linked.isEmpty())
    }

    @Test
    fun rowsWithNoIdAreDropped() {
        val decoded = decodeInvoiceLedgerPayments(ledger(listOf(row("", 4200), row("p2", 500))))
        assertEquals(listOf("p2"), decoded.linked.map { it.paymentId })
    }

    // ── The client call ─────────────────────────────────────────────────────

    @Test
    fun theClientAsksGetInvoiceLedgerForThisInvoice() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("getInvoiceLedger" to ledger(listOf(row("p1", 4200))))
        val r = FirestoreClient().getInvoiceLedgerPayments("inv1")
        assertTrue(r is WriteResult.Ok, "$r")
        assertEquals("p1", (r as WriteResult.Ok).value.linked.single().paymentId)
        val (name, json) = JvmFirestoreFixtures.callablePayloads.single()
        assertEquals("getInvoiceLedger", name)
        assertEquals("inv1", Json.parseToJsonElement(json).jsonObject["invoiceId"]!!.jsonPrimitive.content)
    }

    @Test
    fun aRefusalComesBackAsAnError() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("getInvoiceLedger" to "Invoice not found.")
        val r = FirestoreClient().getInvoiceLedgerPayments("inv1")
        assertTrue(r is WriteResult.Err && r.message == "Invoice not found.", "$r")
    }

    @Test
    fun anUnreadableAnswerIsAnErrorNotAnEmptyList() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("getInvoiceLedger" to "not json")
        assertTrue(FirestoreClient().getInvoiceLedgerPayments("inv1") is WriteResult.Err)
    }

    // ── The screen ──────────────────────────────────────────────────────────

    private val invoice = Invoice(
        _id = "inv1",
        kinfolkId = "k1",
        kinfolkName = "Halbrook Household",
        invoiceNumber = "1029",
        // "open" is a state that offers Record payment (#1238).
        status = "open",
        total = 137.5,
        amountDue = 137.5,
    )

    private fun render(ledgerBody: String, check: androidx.compose.ui.test.ComposeUiTest.() -> Unit) =
        runDesktopComposeUiTest {
            JvmFirestoreFixtures.invoices = listOf(invoice)
            JvmFirestoreFixtures.sessionsForKinfolk = emptyList()
            // The raw rows the console used to read: a card row stored in cents,
            // and a hand-recorded row whose amount already holds its tip. If the
            // screen still read these, it would print $4,200.00 and $147.50.
            JvmFirestoreFixtures.payments = listOf(
                Payment(_id = "p1", kinfolkId = "k1", invoiceId = "inv1", paymentMethod = "card", amount = 4200.0),
                Payment(_id = "p2", kinfolkId = "k1", invoiceId = "inv1", paymentMethod = "Venmo", amount = 137.5, tip = 10.0),
            )
            JvmFirestoreFixtures.callableResponses = mapOf(
                "getInvoiceLedger" to ledgerBody,
                "recordPayment" to RECORD_OK,
            )
            setContent {
                AuntieAppTheme(themeMode = ThemeMode.DARK) {
                    InvoiceDetailScreen(invoiceId = "inv1")
                }
            }
            waitUntil(timeoutMillis = 10_000) { shown("Download PDF") }
            check()
        }

    @Test
    fun theScreenShowsTheServerAmountsNotTheRawRows() = render(
        ledger(listOf(row("p1", 4200), row("p2", 13750, tipCents = 1000, method = "Venmo"))),
    ) {
        waitUntil(timeoutMillis = 10_000) { shown("\$42.00") }
        assertTrue(shown("\$137.50"), "the tipped payment at its amount")
        assertFalse(shown("\$4,200.00"), "never the card row's cents read as dollars")
        assertFalse(shown("\$147.50"), "never the tip counted twice")
    }

    @Test
    fun anUnreadableRowOnTheScreenSaysSo() = render(ledger(listOf(row("p1", 0, resolved = false)))) {
        waitUntil(timeoutMillis = 10_000) { shown(LEDGER_AMOUNT_UNREAD) }
        // The amount and the balance worked out from it both say so. Tip and
        // fee are read from their own fields and do print $0.00 here.
        assertEquals(2, onAllNodesWithText(LEDGER_AMOUNT_UNREAD, useUnmergedTree = true).fetchSemanticsNodes().size)
        assertTrue(shown("Some of these rows cannot be reconciled"))
    }

    @Test
    fun anUnreadableRowWithMoneyAppliedShowsNoBalanceOnTheScreen() = render(
        // What the server sends for such a row: amount floored at 0, so the
        // balance it worked out is 0 - 127.50.
        ledger(listOf(row("p1", 0, resolved = false, appliedCents = 12750, unappliedCents = -12750))),
    ) {
        waitUntil(timeoutMillis = 10_000) { shown(LEDGER_AMOUNT_UNREAD) }
        assertEquals(2, onAllNodesWithText(LEDGER_AMOUNT_UNREAD, useUnmergedTree = true).fetchSemanticsNodes().size)
        assertTrue(shown("\$127.50"), "what was applied is its own stored figure and still shows")
        assertFalse(shown("-\$127.50"), "never a balance worked out from an amount nobody could read")
        assertTrue(shown("The amount on this row could not be read"))
        assertFalse(shown("More was applied"), "an unread amount is not an over-application")
    }

    // ── #2391: the breakdown, and #2390: the whole date ─────────────────────

    private fun one(json: String): InvoiceLedgerPayment = decodeInvoiceLedgerPayments(ledger(listOf(json))).linked.single()

    @Test
    fun aTippedPaymentBreaksDownAsAppliedGrossTipFeeAndBalance() {
        val p = one(row("p1", 13750, tipCents = 1000, feeCents = 271))
        assertEquals("\$127.50", ledgerRowAppliedLabel(p))
        assertEquals("#1029", ledgerRowAppliedTo(p))
        assertEquals("\$10.00", ledgerRowTipLabel(p), "the gross tip, not the net after the fee")
        assertEquals("gross", ledgerRowTipNote(p))
        assertEquals("\$2.71", ledgerRowFeeLabel(p))
        assertEquals("\$0.00", ledgerRowBalanceLabel(p))
        assertEquals(null, ledgerRowBalanceNote(p))
        assertEquals("", ledgerRowCaveat(p))
    }

    @Test
    fun aPaymentAppliedToAnInvoiceWithNoNumberSaysSoAndNeverShowsTheStoredId() {
        // #2420: the "Applied to" line showed the stored id here.
        val p = one(row("p1", 4200)).copy(appliedInvoiceId = "k3Jx9QpLm2", appliedInvoiceNumber = " ")
        assertEquals("an invoice with no number", ledgerRowAppliedTo(p))
        assertEquals("\$42.00", ledgerRowAppliedLabel(p), "the money still applied, so the figure still shows")
    }

    @Test
    fun aPaymentThatTouchedNoBalanceSaysNotApplied() {
        val p = one(row("p1", 4200, appliedCents = 0, appliedNumber = ""))
        assertEquals("not applied", ledgerRowAppliedLabel(p))
        assertEquals("", ledgerRowAppliedTo(p))
        assertEquals("\$42.00", ledgerRowBalanceLabel(p))
    }

    @Test
    fun aLeftoverMovedToCreditSaysSo() {
        val p = one(row("p1", 5000, appliedCents = 4000, autoApply = true))
        assertEquals("\$10.00", ledgerRowBalanceLabel(p))
        assertEquals("held as credit", ledgerRowBalanceNote(p))
    }

    @Test
    fun aLeftoverNotMovedToCreditCarriesNoNote() {
        val p = one(row("p1", 5000, appliedCents = 4000, autoApply = false))
        assertEquals("\$10.00", ledgerRowBalanceLabel(p))
        assertEquals(null, ledgerRowBalanceNote(p))
    }

    @Test
    fun aMigratedRowWithoutItsFeeIsMarkedAndNotGuessed() {
        val p = one(row("p1", 13750, tipCents = 729, tipBasis = "unknown", reconciles = false))
        assertEquals("not recorded", ledgerRowFeeLabel(p))
        assertEquals("\$7.29", ledgerRowTipLabel(p), "the stored tip as it is, no gross worked back from it")
        assertEquals(null, ledgerRowTipNote(p), "an unknown-basis tip is not called gross")
        assertTrue(ledgerRowCaveat(p).startsWith("This row was migrated without its processor fee"))
    }

    @Test
    fun aRowWithNoFeeChargedShowsZeroNotNotRecorded() {
        val p = one(row("p1", 4200))
        assertEquals("\$0.00", ledgerRowFeeLabel(p))
        assertEquals(null, ledgerRowTipNote(p), "a zero tip is not marked gross")
    }

    @Test
    fun aRowMissingItsBreakdownKeysIsNotClaimedToBalance() {
        val p = decodeInvoiceLedgerPayments(
            """{"ledgerPayments":[{"paymentId":"p1","amountCents":4200,"amountResolved":true}]}""",
        ).linked.single()
        assertFalse(p.reconciles, "an absent reconciles is not a checked row")
        assertEquals("not recorded", ledgerRowFeeLabel(p))
        assertEquals("not applied", ledgerRowAppliedLabel(p))
    }

    @Test
    fun anOverAppliedRowDoesNotRenderAsBalanced() {
        val p = one(row("p1", 4000, appliedCents = 5000))
        assertEquals("-\$10.00", ledgerRowBalanceLabel(p))
        assertTrue(ledgerRowCaveat(p).startsWith("More was applied"))
    }

    @Test
    fun anUnreadableRowWithMoneyAppliedIsNotCalledOverApplied() {
        val p = one(row("p1", 0, resolved = false, appliedCents = 12750, unappliedCents = -12750))
        assertEquals(-12750L, p.unappliedCents, "the decoder keeps the server's signed figure")
        assertEquals(LEDGER_AMOUNT_UNREAD, ledgerRowBalanceLabel(p))
        assertEquals(null, ledgerRowBalanceNote(p))
        assertTrue(ledgerRowCaveat(p).startsWith("The amount on this row could not be read"))
    }

    @Test
    fun aHandWrittenDateShowsWhole() {
        assertEquals("February 17, 2026", ledgerRowDateLabel(one(row("p1", 100, date = "February 17, 2026"))))
    }

    @Test
    fun anIsoDateReadsInTheMediumStyle() {
        assertEquals("Oct 12, 2026", ledgerRowDateLabel(one(row("p1", 100, date = "2026-10-12"))))
        assertEquals("Oct 12, 2026", ledgerRowDateLabel(one(row("p1", 100, date = "2026-10-12T15:04:05.000Z"))))
        assertEquals("Oct 12, 2026", ledgerRowDateLabel(one(row("p1", 100, date = "2026-10-12 15:04"))))
    }

    @Test
    fun textThatOnlyStartsLikeADayIsShownAsStored() {
        assertEquals("2026-10-12th", ledgerRowDateLabel(one(row("p1", 100, date = "2026-10-12th"))))
        assertEquals("2026-10-123", ledgerRowDateLabel(one(row("p1", 100, date = "2026-10-123"))))
        assertEquals("2026-02-30", ledgerRowDateLabel(one(row("p1", 100, date = "2026-02-30"))), "not a real day")
        assertEquals("10/12/2026", ledgerRowDateLabel(one(row("p1", 100, date = "10/12/2026"))))
    }

    @Test
    fun aMissingDateOrMethodSaysSo() {
        val p = one(row("p1", 100, date = "", method = ""))
        assertEquals("no date recorded", ledgerRowDateLabel(p))
        assertEquals("no method recorded", ledgerRowMethodLabel(p))
    }

    @Test
    fun theScreenShowsTheBreakdownAndTheWholeDate() = render(
        ledger(listOf(row("p2", 13750, tipCents = 1000, feeCents = 271, method = "Venmo", date = "February 17, 2026"))),
    ) {
        waitUntil(timeoutMillis = 10_000) { shown("\$137.50") }
        assertTrue(shown("February 17, 2026"), "the whole date, not \"February 1\"")
        assertTrue(shown("APPLIED TO"))
        assertTrue(shown("\$127.50"))
        assertTrue(shown("#1029"))
        assertTrue(shown("\$10.00"), "the gross tip")
        assertTrue(shown("gross"))
        assertTrue(shown("\$2.71"), "the fee beside it")
        assertTrue(shown("BALANCE"))
        assertFalse(shown("\$147.50"), "the tip sits beside the amount, never on top of it")
        assertFalse(shown("\$7.29"), "the gross tip, never the net after the fee")
        assertFalse(shown("Some of these rows cannot be reconciled"), "a balanced row raises no caveat")
    }

    @Test
    fun aHouseholdPaymentNamingNoInvoiceShowsUnderTheBanner() =
        render(ledger(linked = emptyList(), unlinked = listOf(row("p9", 4200)))) {
            waitUntil(timeoutMillis = 10_000) { shown("NOT INVOICE-LINKED") }
            assertTrue(shown("\$42.00"))
        }

    @Test
    fun aLedgerThatCannotBeReadSaysSo() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.invoices = listOf(invoice)
        JvmFirestoreFixtures.sessionsForKinfolk = emptyList()
        JvmFirestoreFixtures.callableErrors = mapOf("getInvoiceLedger" to "Invoice not found.")
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) { InvoiceDetailScreen(invoiceId = "inv1") }
        }
        waitUntil(timeoutMillis = 10_000) { shown("Couldn't load payments: Invoice not found.") }
    }

    @Test
    fun aFailedLedgerReadCanBeTriedAgain() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.invoices = listOf(invoice)
        JvmFirestoreFixtures.sessionsForKinfolk = emptyList()
        JvmFirestoreFixtures.callableErrors = mapOf("getInvoiceLedger" to "The service is unavailable.")
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) { InvoiceDetailScreen(invoiceId = "inv1") }
        }
        waitUntil(timeoutMillis = 10_000) { shown("Couldn't load payments: The service is unavailable.") }
        fun ledgerReads() = JvmFirestoreFixtures.callablePayloads.count { it.first == "getInvoiceLedger" }
        assertEquals(1, ledgerReads(), "the invoice has not changed, so nothing asks again by itself")
        // The next read answers.
        JvmFirestoreFixtures.callableErrors = emptyMap()
        JvmFirestoreFixtures.callableResponses = mapOf("getInvoiceLedger" to ledger(listOf(row("p1", 4200))))
        // Other panels on this screen can offer their own Try again; the
        // Payments panel sits above them, so its button is the first.
        fun retries() = onAllNodesWithText("Try again").fetchSemanticsNodes().size
        val before = retries()
        onAllNodesWithText("Try again")[0].performScrollTo().performClick()
        waitUntil(timeoutMillis = 10_000) { shown("\$42.00") }
        assertEquals(2, ledgerReads())
        assertFalse(shown("Couldn't load payments"), "the failure is gone once the read answers")
        assertEquals(before - 1, retries(), "the Payments panel's Try again leaves with the failure")
    }
    @Test
    fun recordingAPaymentReadsTheLedgerAgain() = render(ledger(listOf(row("p1", 4200)))) {
        waitUntil(timeoutMillis = 10_000) { shown("\$42.00") }
        fun ledgerReads() = JvmFirestoreFixtures.callablePayloads.count { it.first == "getInvoiceLedger" }
        assertEquals(1, ledgerReads())

        onAllNodesWithText("Record payment")[0].performScrollTo().performClick()
        waitUntil(timeoutMillis = 10_000) { shown("Applies a payment to invoice #1029.") }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodes(hasContentDescription("Method *") and hasSetTextAction()).fetchSemanticsNodes().isNotEmpty()
        }
        onNode(hasContentDescription("Method *") and hasSetTextAction()).performScrollTo().performTextInput("Venmo")
        // The dialog's own button is the last "Record payment" on screen.
        val buttons = onAllNodesWithText("Record payment")
        buttons[buttons.fetchSemanticsNodes().size - 1].performClick()

        waitUntil(timeoutMillis = 10_000) {
            JvmFirestoreFixtures.callablePayloads.any { it.first == "recordPayment" } && ledgerReads() >= 2
        }
    }

    private companion object {
        val RECORD_OK = """
            {"ok":true,"paymentId":"pay_1","kinfolkId":"k1","amountCents":13750,"tipCents":0,"feeCents":0,
             "tipBasis":"gross","appliedCents":13750,"unappliedCents":0,"proceedsCents":13750,"tipNetCents":0,
             "autoApply":false,
             "application":{"invoiceId":"inv1","invoiceNumber":"1029","paymentId":"ip1","appliedCents":13750,
               "state":"settled","totalCents":13750,"paidCents":13750,"amountDueCents":0,"overpaidCents":0},
             "creditedToAccountCents":0,"confirmationEmailSent":false,"householdNoPortalAccount":false,"officeNoticePending":false}
        """.trimIndent()
    }
}
