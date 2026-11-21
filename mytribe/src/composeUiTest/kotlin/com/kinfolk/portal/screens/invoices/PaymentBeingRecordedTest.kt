@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.invoices

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
 * #2437: the server refused a Pay because a payment on the invoice has
 * finished at Stripe and is not recorded yet. Both screens print its sentence
 * where Pay was, once, with the check running beside it.
 */
class PaymentBeingRecordedTest {

    private val sentence = "A payment on this invoice is still being recorded. Check again in a minute."
    private val card = PayMethod("stripe", "Pay with Credit Card", PayMethodKind.Checkout, null)

    private fun invoice() = Invoice(
        id = "1042",
        kinfolkId = "3",
        kinfolkName = null,
        client = "Buddy (Nora)",
        total = 40.0,
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
    )

    @Test
    fun detail_printsTheSentenceWherePayWas_withTheCheckRunning() = runComposeUiTest {
        // KinLoading's ring is an infinite transition: drive the clock by hand.
        mainClock.autoAdvance = false
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                invoice(),
                payMethods = listOf(card),
                checkingPayment = true,
                paymentBeingRecorded = true,
                onBack = {},
            )
        }
        mainClock.advanceTimeBy(16L)
        onNodeWithTag("invoice-payment-being-recorded").assertIsDisplayed().assertTextEquals(sentence)
        onAllNodesWithText(sentence, useUnmergedTree = true).assertCountEquals(1)
        onNodeWithText("Checking payment…").assertIsDisplayed()
        onNodeWithText("Pay with Credit Card").assertDoesNotExist()
        // The status is the server's until the webhook changes it.
        onNodeWithText("Pending").assertIsDisplayed()
    }

    @Test
    fun detail_anOrdinaryCheckAfterAReturnFromStripe_printsNoSentence() = runComposeUiTest {
        mainClock.autoAdvance = false
        setThemedContent {
            InvoiceDetailScreen("The Foster", invoice(), payMethods = listOf(card), checkingPayment = true, onBack = {})
        }
        mainClock.advanceTimeBy(16L)
        onNodeWithText("Checking payment…").assertIsDisplayed()
        onNodeWithTag("invoice-payment-being-recorded").assertDoesNotExist()
    }

    @Test
    fun detail_onceTheCheckHasEnded_theSentenceIsGone() = runComposeUiTest {
        setThemedContent {
            // The flag alone, with no check running, draws nothing: the sentence belongs to the check.
            InvoiceDetailScreen("The Foster", invoice(), payMethods = listOf(card), paymentBeingRecorded = true, onBack = {})
        }
        waitForIdle()
        onNodeWithTag("invoice-payment-being-recorded").assertDoesNotExist()
        onNodeWithText("Pay with Credit Card").assertIsDisplayed()
    }

    private fun invoiceJson(id: String, amountDue: Double): JsonObject = buildJsonObject {
        put("id", id)
        put("kinfolkId", "3")
        put("amountDue", amountDue)
        put("total", amountDue)
        put("isPaid", false)
        put("status", "open")
        put("client", "Buddy (Nora)")
        put("payMethods", buildJsonArray {})
    }

    @Test
    fun list_aRefusedPay_printsTheSentenceOnThatRowOnce_andKeepsTheList() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {
                add(invoiceJson("a1", 40.0))
                add(invoiceJson("b2", 55.0))
            })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
        fake.stubError("payInvoice", IllegalStateException(sentence))
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        // The check that follows reads the bill every few seconds for a minute: drive the clock by hand.
        mainClock.autoAdvance = false
        onNodeWithText("Pay \$40.00").performClick()
        mainClock.advanceTimeBy(100L)

        // The row is one tappable node, so its lines are read off the unmerged tree.
        onNodeWithTag("invoice-row-payment-being-recorded", useUnmergedTree = true).assertIsDisplayed().assertTextEquals(sentence)
        // Once: not also as the list's own error, which would hide every invoice.
        onAllNodesWithText(sentence, useUnmergedTree = true).assertCountEquals(1)
        onNodeWithText("Couldn't load invoices").assertDoesNotExist()
        onNodeWithText("Pay \$40.00").assertDoesNotExist()
        onNodeWithText("Checking payment…").assertIsDisplayed().assertIsNotEnabled()
        // The other bill is untouched.
        onNodeWithText("Pay \$55.00").assertIsDisplayed()
    }
}
