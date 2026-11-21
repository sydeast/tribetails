@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.invoices

import androidx.compose.ui.test.assertIsDisplayed
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
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #2442: A REFUSED PAY LEAVES THE OPEN INVOICES DRAWN.
 *
 * The list used to swap the whole Open Invoices card for "Couldn't load
 * invoices" with the refusal under it. Now the rows stay and the server's
 * sentence goes under the row that was tapped. The title is kept for a list
 * that really could not be read. The invoice screen, which showed nothing for
 * a refused Pay or a failed PDF, prints both.
 */
class PayFailureKeepsListTest {

    private val refusal = "This invoice cannot take a payment right now. Please ask your Auntie to check it."

    private fun row(id: String, number: String, amountDue: Double): JsonObject = buildJsonObject {
        put("id", id)
        put("invoiceNumber", number)
        put("kinfolkId", "3")
        put("amountDue", amountDue)
        put("total", amountDue)
        put("isPaid", false)
        put("status", "open")
        put("client", "Buddy (Nora)")
        put("dueDate", "Sep 17, 2025")
    }

    private fun stubTwoOpen(fake: FakeFunctionsClient) {
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {
                add(row("inv-1", "1001", 40.0))
                add(row("inv-2", "1002", 55.0))
            })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
    }

    @Test
    fun list_aRefusedPay_keepsEveryOpenRowAndPrintsTheSentenceOnce() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubTwoOpen(fake)
        fake.stubError("payInvoice", IllegalStateException(refusal))
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Pay \$40.00").performClick()
        waitForIdle()

        onNodeWithText("Couldn't load invoices").assertDoesNotExist()
        onNodeWithText("Invoice #1001").assertIsDisplayed()
        onNodeWithText("Invoice #1002").assertIsDisplayed()
        onNodeWithText("Pay \$55.00").assertIsDisplayed()
        onNodeWithTag("invoice-row-pay-error", useUnmergedTree = true).assertIsDisplayed().assertTextEquals(refusal)
        assertEquals(1, onAllNodesWithText(refusal, useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    @Test
    fun list_anOfflinePay_keepsTheRowsToo() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubTwoOpen(fake)
        fake.stubError("payInvoice", IllegalStateException("Could not reach the server. Check your connection."))
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Pay \$55.00").performClick()
        waitForIdle()

        onNodeWithText("Couldn't load invoices").assertDoesNotExist()
        onNodeWithText("Invoice #1001").assertIsDisplayed()
        onNodeWithTag("invoice-row-pay-error", useUnmergedTree = true)
            .assertIsDisplayed()
            .assertTextEquals("Could not reach the server. Check your connection.")
    }

    @Test
    fun list_aFirstReadThatFails_stillSaysItCouldNotLoad() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyInvoices", IllegalStateException("network down"))
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Couldn't load invoices").assertIsDisplayed()
        onNodeWithTag("invoice-row-pay-error", useUnmergedTree = true).assertDoesNotExist()
    }

    /**
     * A list already in hand stays drawn when a later read of it fails. The
     * "Couldn't load invoices" title is for a list with nothing to show
     * (#2442), but the failed read is still said, with a way to read again,
     * as the web portal does. The rows are the last copy that was read.
     */
    @Test
    fun list_aLaterReadThatFails_keepsTheRowsItHas() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubTwoOpen(fake)
        val readAgain = androidx.compose.runtime.mutableStateOf(0)
        val api = PortalApi(fake)
        setThemedContent {
            val c = rememberInvoicesController("3", api)
            androidx.compose.runtime.LaunchedEffect(readAgain.value) { if (readAgain.value > 0) c.reload() }
            InvoicesScreen("The Foster", "3", api, controller = c)
        }
        waitForIdle()
        onNodeWithText("Invoice #1001").assertIsDisplayed()
        fake.stubError("getMyInvoices", IllegalStateException("network down"))
        readAgain.value = 1
        waitForIdle()
        kotlin.test.assertTrue(fake.calls.count { it.first == "getMyInvoices" } >= 2, "the list was read again")
        onNodeWithText("Couldn't load invoices").assertDoesNotExist()
        onNodeWithText("Invoice #1001").assertIsDisplayed()
        onNodeWithText("Invoice #1002").assertIsDisplayed()
        // The failed read is not hidden: it is said over the rows it kept.
        onNodeWithTag("invoices-refresh-failed").assertIsDisplayed()
        onNodeWithText("Couldn't refresh your invoices.").assertIsDisplayed()

        // Try again reads the list again; once a read gets through, the line goes.
        val readsBefore = fake.calls.count { it.first == "getMyInvoices" }
        stubTwoOpen(fake)
        onNodeWithText("Try again").performClick()
        waitForIdle()
        kotlin.test.assertTrue(fake.calls.count { it.first == "getMyInvoices" } > readsBefore, "Try again read the list")
        onNodeWithTag("invoices-refresh-failed").assertDoesNotExist()
        onNodeWithText("Invoice #1001").assertIsDisplayed()
    }

    /** The wait after Try again is seen: a spinner in place of the button until the read is over. */
    @Test
    fun list_tryAgain_showsTheSpinnerWhileTheReadIsOut() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubTwoOpen(fake)
        var gate: kotlinx.coroutines.CompletableDeferred<Unit>? = null
        val held = object : com.kinfolk.portal.firebase.FunctionsClient {
            override suspend fun call(name: String, payload: JsonObject?): JsonObject {
                if (name == "getMyInvoices") gate?.await()
                return fake.call(name, payload)
            }
        }
        val readAgain = androidx.compose.runtime.mutableStateOf(0)
        val api = PortalApi(held)
        setThemedContent {
            val c = rememberInvoicesController("3", api)
            androidx.compose.runtime.LaunchedEffect(readAgain.value) { if (readAgain.value > 0) c.reload() }
            InvoicesScreen("The Foster", "3", api, controller = c)
        }
        waitForIdle()
        fake.stubError("getMyInvoices", IllegalStateException("network down"))
        readAgain.value = 1
        waitForIdle()
        onNodeWithTag("invoices-refresh-failed").assertIsDisplayed()

        val read = kotlinx.coroutines.CompletableDeferred<Unit>()
        gate = read
        stubTwoOpen(fake)
        onNodeWithText("Try again").performClick()
        waitForIdle()
        onNodeWithTag("invoices-refresh-spinner", useUnmergedTree = true).assertExists()
        onNodeWithText("Try again").assertDoesNotExist()

        read.complete(Unit)
        waitForIdle()
        onNodeWithTag("invoices-refresh-spinner", useUnmergedTree = true).assertDoesNotExist()
        onNodeWithTag("invoices-refresh-failed").assertDoesNotExist()
        onNodeWithText("Invoice #1001").assertIsDisplayed()
    }

    /** A first read that fails has nothing to keep: the title says so, and no refresh line is drawn over it. */
    @Test
    fun list_aFirstReadThatFails_drawsNoRefreshLine() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyInvoices", IllegalStateException("network down"))
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Couldn't load invoices").assertIsDisplayed()
        onNodeWithTag("invoices-refresh-failed").assertDoesNotExist()
    }

    /** A refused Pay is about one bill, not the list: no refresh line. */
    @Test
    fun list_aRefusedPay_drawsNoRefreshLine() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubTwoOpen(fake)
        fake.stubError("payInvoice", IllegalStateException(refusal))
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Pay \$40.00").performClick()
        waitForIdle()
        onNodeWithTag("invoices-refresh-failed").assertDoesNotExist()
    }
    private fun invoice(payBlockedReason: String? = null) = Invoice(
        id = "inv-1",
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
        payBlockedReason = payBlockedReason,
    )

    private val stripe = PayMethod("stripe", "Pay with Credit Card", PayMethodKind.Checkout, null)

    @Test
    fun detail_aRefusedPay_printsTheSentenceAndKeepsTheWayToPay() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                invoice(),
                payMethods = listOf(stripe),
                payError = refusal,
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithTag("invoice-pay-error").assertIsDisplayed().assertTextEquals(refusal)
        onNodeWithText("Pay with Credit Card").assertIsDisplayed()
    }

    @Test
    fun detail_aFailedPdf_printsItsSentence() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                invoice(),
                payMethods = listOf(stripe),
                pdfError = "The PDF could not be made.",
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithTag("invoice-pdf-error").assertIsDisplayed().assertTextEquals("The PDF could not be made.")
        onNodeWithTag("invoice-pay-error").assertDoesNotExist()
    }

    @Test
    fun detail_aBlockedBillsOwnSentence_isPrintedOnce() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                invoice(payBlockedReason = refusal),
                payMethods = listOf(stripe),
                payError = refusal,
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithTag("invoice-pay-blocked").assertIsDisplayed()
        onNodeWithTag("invoice-pay-error").assertDoesNotExist()
        assertEquals(1, onAllNodesWithText(refusal, useUnmergedTree = true).fetchSemanticsNodes().size)
    }
}
