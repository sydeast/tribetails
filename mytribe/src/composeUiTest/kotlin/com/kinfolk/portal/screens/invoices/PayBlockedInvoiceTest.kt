@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PayMethod
import com.kinfolk.portal.portal.PayMethodKind
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test

/**
 * #2410: AN OPEN BILL THE SERVER SAYS CANNOT TAKE A PAYMENT OFFERS NO PAY.
 *
 * The server ships `payBlockedReason` for an invoice that states a balance
 * while nothing is owed on its total. The row carries no Pay button, and the
 * invoice screen prints the server's sentence where the pay options were,
 * whatever list of options it was handed.
 */
class PayBlockedInvoiceTest {

    private val sentence = "This invoice cannot take a payment right now. Please ask your Auntie to check it."
    private val stripe = PayMethod("stripe", "Pay with Credit Card", PayMethodKind.Checkout, null)
    private val venmo = PayMethod("venmo", "Pay with Venmo", PayMethodKind.Link, "https://venmo.com/u/auntie")

    private fun invoice(payBlockedReason: String?) = Invoice(
        id = "1042",
        kinfolkId = "3",
        kinfolkName = null,
        client = "Buddy (Nora)",
        total = 0.0,
        amountDue = 40.0,
        isPaid = false,
        status = InvoiceStatus.Open,
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
        payBlockedReason = payBlockedReason,
    )

    @Test
    fun detail_aBlockedBill_printsWhyAndOffersNoWayToPay() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                invoice(sentence),
                // Even when a list of options reaches the screen, none is drawn.
                payMethods = listOf(stripe, venmo),
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithTag("invoice-pay-blocked").assertIsDisplayed().assertTextEquals(sentence)
        onNodeWithText("Pay with Credit Card").assertDoesNotExist()
        onNodeWithText("Pay with Venmo").assertDoesNotExist()
        onNodeWithText("Download PDF").assertIsDisplayed()
    }

    @Test
    fun detail_anOrdinaryOpenBill_offersPaymentAndPrintsNoReason() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                invoice(null),
                payMethods = listOf(stripe),
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithText("Pay with Credit Card").assertIsDisplayed()
        onNodeWithTag("invoice-pay-blocked").assertDoesNotExist()
    }

    private fun invoiceJson(id: String, amountDue: Double, reason: String?): JsonObject = buildJsonObject {
        put("id", id)
        put("kinfolkId", "3")
        put("amountDue", amountDue)
        put("total", 0.0)
        put("isPaid", false)
        put("status", "open")
        put("client", "Buddy (Nora)")
        put("payMethods", buildJsonArray {})
        if (reason == null) put("payBlockedReason", JsonNull) else put("payBlockedReason", reason)
    }

    @Test
    fun list_noPayButtonOnABlockedRow_andAnOrdinaryRowKeepsIts() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {
                add(invoiceJson("b1", 40.0, sentence))
                add(invoiceJson("o1", 55.0, null))
            })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Pay \$40.00").assertDoesNotExist()
        onNodeWithText("Pay \$55.00").assertIsDisplayed()
    }
}
