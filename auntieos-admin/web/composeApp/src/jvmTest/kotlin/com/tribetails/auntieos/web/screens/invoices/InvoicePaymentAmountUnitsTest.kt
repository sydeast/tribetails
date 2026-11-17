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
import com.tribetails.auntieos.web.data.ledgerPaymentAmountLabel
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
    ) = """
        {"paymentId":"$id","amountCents":$amountCents,"amountResolved":$resolved,"tipCents":$tipCents,
         "feeCents":$feeCents,"tipBasis":"gross","reconciles":true,"appliedCents":$amountCents,
         "unappliedCents":0,"proceedsCents":${amountCents - feeCents},"autoApply":false,
         "appliedInvoiceId":"inv1","appliedInvoiceNumber":"1029","method":"$method","reference":"",
         "date":"2026-10-12","notes":"","recordedBy":null}
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
        assertFalse(shown("\$0.00"), "an unread amount is not a payment of nothing")
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
