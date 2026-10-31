package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.Payment
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1238: what the desktop invoice Payments panel offers and shows. Record
 * payment follows the stored stamp; the payments already recorded render in
 * every state, so gating the button never hides money already taken.
 */
@OptIn(ExperimentalTestApi::class)
class InvoicePaymentsPanelRenderTest {

    private fun SemanticsNodeInteractionsProvider.shown(text: String): Boolean =
        onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private val payment = Payment(
        _id = "p1",
        kinfolkId = "k1",
        date = "2026-10-12",
        paymentMethod = "Zelle",
        amount = 40.0,
        invoiceId = "inv1",
    )

    private fun renderPanel(
        status: String,
        linked: List<Payment>,
        history: String = "",
        check: SemanticsNodeInteractionsProvider.() -> Unit,
    ) = runDesktopComposeUiTest {
        val invoice = Invoice(_id = "inv1", kinfolkId = "k1", status = status, paymentsHistory = history)
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                InvoicePaymentsPanel(
                    invoice = invoice,
                    actions = invoiceActionsFor(invoiceStateOrNull(invoice)),
                    paymentsState = FirestoreResult.Data(linked),
                    linkedPayments = linked,
                    clientPayments = linked,
                    onRecordPayment = {},
                )
            }
        }
        waitUntil(timeoutMillis = 10_000) { shown("Payments") }
        check()
    }

    @Test
    fun anOpenInvoiceOffersRecordPayment() = renderPanel("open", emptyList()) {
        assertTrue(shown("Record payment"), "an open bill takes a payment")
        assertTrue(shown("Use Record payment to log one."), "the empty line points at the button")
    }

    @Test
    fun anOpenInvoiceWithAPaymentShowsBothTheButtonAndThePayment() = renderPanel("open", listOf(payment)) {
        assertTrue(shown("Record payment"), "a part-paid bill can collect the rest")
        assertTrue(shown("Zelle"))
    }

    @Test
    fun noOtherStateOffersRecordPaymentButRecordedPaymentsStillShow() {
        for (status in listOf("paid", "cancelled", "quote", "draft", "credit", "redeemed", "zero", "sent")) {
            renderPanel(status, listOf(payment)) {
                assertFalse(shown("Record payment"), "$status offers no payment")
                assertTrue(shown("Zelle"), "$status still shows the recorded payment")
                assertTrue(shown("\$40.00"), "$status still shows its amount")
            }
        }
    }

    @Test
    fun aPaidInvoiceKeepsItsLegacyHistoryText() =
        renderPanel("paid", emptyList(), history = "Paid by check 2026-09-01") {
            assertFalse(shown("Record payment"))
            assertTrue(shown("Paid by check 2026-09-01"), "legacy history text renders")
        }

    @Test
    fun aPaidInvoiceWithNothingRecordedSaysSoWithoutPointingAtAMissingButton() = renderPanel("paid", emptyList()) {
        assertFalse(shown("Record payment"))
        assertTrue(shown("No payment recorded against this invoice."))
        assertFalse(shown("Use Record payment"), "no pointer at a button that is not there")
    }
}
