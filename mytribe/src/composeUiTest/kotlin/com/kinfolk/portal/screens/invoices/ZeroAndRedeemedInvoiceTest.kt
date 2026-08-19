@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.CreditTarget
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PayMethod
import com.kinfolk.portal.portal.PayMethodKind
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The last two states of the Invoice State Stamp to reach this client: `zero`
 * and `redeemed` (issue #449).
 *
 * Both used to fall through `decodeInvoiceStatus`'s `else` to `Open`, which is
 * the same hole a quote fell through before issue #385 and it fails the same
 * way: a household is shown a state the server did not send, with the
 * affordance that state carries. A $0 invoice was captioned "PENDING" and
 * offered a Pay button; a spent credit was captioned "PENDING" too, and
 * because `invoiceEditPolicy.ts` documents a redeemed credit that still
 * carries a positive `amountDue`, the detail screen would offer to collect
 * money against it.
 */
class ZeroAndRedeemedInvoiceTest {

    // ---- Decode ----

    private fun stubInvoices(
        fake: FakeFunctionsClient,
        open: List<JsonObject> = emptyList(),
        credits: List<JsonObject> = emptyList(),
    ) {
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray { open.forEach { add(it) } })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray { credits.forEach { add(it) } })
        })
    }

    private fun zeroInvoiceJson() = buildJsonObject {
        put("id", "z1")
        put("kinfolkId", "3")
        put("amountDue", 0.0)
        put("total", 0.0)
        put("isPaid", false)
        put("status", "zero")
        put("client", "Buddy (Nora)")
    }

    /**
     * A redeemed credit whose `amountDue` still reads positive. Not a contrived
     * document: `invoiceEditPolicy.ts` names this exact shape (a doc labelled
     * for the credit family whose money never independently said credit) as
     * reachable through `redeemCredit`'s own guard.
     */
    private fun redeemedCreditJson() = buildJsonObject {
        put("id", "c1")
        put("kinfolkId", "3")
        put("amountDue", 40.0)
        put("total", 40.0)
        put("isPaid", false)
        put("status", "redeemed")
        put("client", "Buddy (Nora)")
        put("creditAmountCents", 4000L)
        put("creditTarget", "accountBalance")
        put("creditRedeemedAtMs", 1_755_000_000_000L)
    }

    @Test
    fun zeroStatus_decodesAsZero_notAsAnOpenBill() = runTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake, open = listOf(zeroInvoiceJson()))
        val inv = PortalApi(fake).getMyInvoices("3").open.single()
        assertEquals(InvoiceStatus.Zero, inv.status)
    }

    @Test
    fun redeemedStatus_decodesAsRedeemed_notAsAnOpenBill() = runTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake, credits = listOf(redeemedCreditJson()))
        val inv = PortalApi(fake).getMyInvoices("3").credits.single()
        assertEquals(InvoiceStatus.Redeemed, inv.status)
        assertEquals(1_755_000_000_000L, inv.creditRedeemedAtMs)
    }

    @Test
    fun anUnreadableStatus_stillFailsSoftToOpen() = runTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake, open = listOf(buildJsonObject {
            put("id", "x1")
            put("kinfolkId", "3")
            put("amountDue", 10.0)
            put("total", 10.0)
            put("isPaid", false)
            put("status", "something-new")
        }))
        assertEquals(InvoiceStatus.Open, PortalApi(fake).getMyInvoices("3").open.single().status)
    }

    // ---- Labels and the payable rule ----

    @Test
    fun bothStatesHaveTheirOwnWordsAndBorrowNobodyElses() {
        assertEquals("Zero balance", invoiceStatusLabel(InvoiceStatus.Zero))
        assertEquals("ZERO", invoiceStatusChipLabel(InvoiceStatus.Zero))
        assertEquals("Redeemed", invoiceStatusLabel(InvoiceStatus.Redeemed))
        assertEquals("REDEEMED", invoiceStatusChipLabel(InvoiceStatus.Redeemed))
    }

    @Test
    fun onlyASentUnsettledBillIsPayable() {
        assertTrue(isPayable(InvoiceStatus.Open))
        listOf(
            InvoiceStatus.Draft,
            InvoiceStatus.Quote,
            InvoiceStatus.Zero,
            InvoiceStatus.Paid,
            InvoiceStatus.Credit,
            InvoiceStatus.Redeemed,
            InvoiceStatus.Cancelled,
        ).forEach { assertFalse(isPayable(it), "$it must not offer payment") }
    }

    @Test
    fun aZeroInvoiceIsNotDueOnADate() {
        val invoice = invoice(status = InvoiceStatus.Zero, amountDue = 0.0, total = 0.0)
        assertEquals("Nothing due", openRowMetaLabel(invoice))
    }

    // ---- The list ----

    @Test
    fun zeroRow_carriesItsOwnChipAndNoPayButton() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake, open = listOf(zeroInvoiceJson()))
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("ZERO").assertIsDisplayed()
        onNodeWithText("Nothing due").assertIsDisplayed()
        onNodeWithText("PENDING").assertDoesNotExist()
        // The old row rendered a "Pay $0.00" button, disabled, on a bill with
        // nothing to collect.
        onNodeWithText("Pay \$0.00").assertDoesNotExist()
    }

    // ---- The detail screen ----

    private fun invoice(
        status: InvoiceStatus,
        amountDue: Double,
        total: Double,
        creditAmountCents: Long? = null,
        creditTarget: CreditTarget? = null,
        creditRedeemedAtMs: Long? = null,
    ) = Invoice(
        id = "1042",
        kinfolkId = "3",
        kinfolkName = null,
        client = "Buddy (Nora)",
        total = total,
        amountDue = amountDue,
        isPaid = false,
        status = status,
        date = "Jun 01, 2026",
        dueDate = "Jun 17, 2026",
        discount = null,
        terms = null,
        paymentsHistory = null,
        address = null,
        viewed = true,
        creditAmountCents = creditAmountCents,
        creditTarget = creditTarget,
        creditRedeemedAtMs = creditRedeemedAtMs,
        originalPaymentIntentId = "pi_xyz",
    )

    private val stripe = PayMethod("stripe", "Pay with Credit Card", PayMethodKind.Checkout, null)

    @Test
    fun zeroInvoice_saysSoAndOffersNoPayment() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                invoice(InvoiceStatus.Zero, amountDue = 0.0, total = 0.0),
                payMethods = listOf(stripe),
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithText("Zero balance").assertIsDisplayed()
        onNodeWithText("Pending").assertDoesNotExist()
        onNodeWithText("Pay with Credit Card").assertDoesNotExist()
    }

    /**
     * THE ONE THAT COSTS MONEY. A credit the household has already spent, whose
     * `amountDue` reads positive, used to decode as `Open` here: not a credit,
     * so no credit panel, and a real Pay button asking them to settle it.
     */
    @Test
    fun redeemedCredit_readsAsASpentCreditAndOffersNoPayment() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                invoice(
                    InvoiceStatus.Redeemed,
                    amountDue = 40.0,
                    total = 40.0,
                    creditAmountCents = 4000L,
                    creditTarget = CreditTarget.AccountBalance,
                    creditRedeemedAtMs = 1_755_000_000_000L,
                ),
                payMethods = listOf(stripe),
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithText("Redeemed").assertIsDisplayed()
        onNodeWithText("Saved to Account Balance").assertIsDisplayed()
        onNodeWithText("Pay with Credit Card").assertDoesNotExist()
        // And it is not offered for spending a second time.
        onNodeWithText("Redeem Credit").assertDoesNotExist()
    }

    @Test
    fun unspentCredit_isStillOfferedForRedemption() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                invoice(
                    InvoiceStatus.Credit,
                    amountDue = -40.0,
                    total = -40.0,
                    creditAmountCents = 4000L,
                ),
                payMethods = listOf(stripe),
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithText("Redeem Credit").assertIsDisplayed()
        onNodeWithText("Save to Account Balance").assertIsDisplayed()
    }
}
