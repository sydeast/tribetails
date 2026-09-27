@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PayMethod
import com.kinfolk.portal.portal.PayMethodKind
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test

/**
 * Operator ruling 2026-09-27 (docket Q5): "Invoices shouldn't allow payment
 * once marked as paid."
 *
 * The shape that matters is a paid invoice whose balance still reads positive
 * (the partial-payment corruption `amountDueRule.ts` describes), or an `isPaid`
 * row the server stamped under a stale `open` label. Neither may show a Pay
 * button, a card checkout, or a Venmo/PayPal link.
 */
class PaidInvoiceTakesNoPaymentTest {

    private val stripe = PayMethod("stripe", "Pay with Credit Card", PayMethodKind.Checkout, null)
    private val venmo = PayMethod("venmo", "Pay with Venmo", PayMethodKind.Link, "https://venmo.com/u/auntie")

    private fun invoice(status: InvoiceStatus, isPaid: Boolean, amountDue: Double) = Invoice(
        id = "1042",
        kinfolkId = "3",
        kinfolkName = null,
        client = "Buddy (Nora)",
        total = 137.5,
        amountDue = amountDue,
        isPaid = isPaid,
        status = status,
        date = "Jun 01, 2026",
        dueDate = "Jun 17, 2026",
        discount = null,
        terms = null,
        paymentsHistory = null,
        address = null,
        viewed = true,
        creditAmountCents = null,
        creditTarget = null,
        creditRedeemedAtMs = null,
        originalPaymentIntentId = null,
    )

    @Test
    fun detail_paidWithABalanceShowing_offersNoWayToPay() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                invoice(InvoiceStatus.Paid, isPaid = true, amountDue = 40.0),
                payMethods = listOf(stripe, venmo),
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithText("Pay with Credit Card").assertDoesNotExist()
        onNodeWithText("Pay with Venmo").assertDoesNotExist()
        onNodeWithText("Download PDF").assertIsDisplayed()
    }

    @Test
    fun detail_isPaidUnderAStaleOpenLabel_offersNoWayToPay() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                invoice(InvoiceStatus.Open, isPaid = true, amountDue = 40.0),
                payMethods = listOf(stripe, venmo),
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithText("Pay with Credit Card").assertDoesNotExist()
        onNodeWithText("Pay with Venmo").assertDoesNotExist()
    }

    @Test
    fun detail_anOpenBill_stillOffersPayment() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                invoice(InvoiceStatus.Open, isPaid = false, amountDue = 40.0),
                payMethods = listOf(stripe),
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithText("Pay with Credit Card").assertIsDisplayed()
    }

    private fun invoiceJson(id: String, status: String, isPaid: Boolean, amountDue: Double): JsonObject =
        buildJsonObject {
            put("id", id)
            put("kinfolkId", "3")
            put("amountDue", amountDue)
            put("total", 137.5)
            put("isPaid", isPaid)
            put("status", status)
            put("client", "Buddy (Nora)")
        }

    @Test
    fun list_noPayButtonOnAPaidRow_inEitherBucket() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            // A row the server marked paid but left in the open bucket with a
            // stale balance, and an ordinary paid row.
            put("open", buildJsonArray { add(invoiceJson("p1", "open", isPaid = true, amountDue = 40.0)) })
            put("paid", buildJsonArray { add(invoiceJson("p2", "paid", isPaid = true, amountDue = 0.0)) })
            put("credits", buildJsonArray {})
        })
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Pay \$40.00").assertDoesNotExist()
        onNodeWithText("Pay \$0.00").assertDoesNotExist()
    }

    @Test
    fun list_anOpenRow_stillCarriesItsPayButton() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray { add(invoiceJson("o1", "open", isPaid = false, amountDue = 40.0)) })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Pay \$40.00").assertIsDisplayed()
    }
}
