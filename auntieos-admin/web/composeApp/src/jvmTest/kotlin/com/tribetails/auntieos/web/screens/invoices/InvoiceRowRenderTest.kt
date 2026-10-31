package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.config.FeatureFlags
import com.tribetails.auntieos.web.config.LocalFeatureFlags
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1256: what the operator sees on a desktop invoice list row. The choice is
 * pinned in `InvoiceRowActionTest`; this pins that the row renders it.
 */
@OptIn(ExperimentalTestApi::class)
class InvoiceRowRenderTest {

    private val today = "2026-10-30"

    private fun SemanticsNodeInteractionsProvider.shown(text: String): Boolean =
        onAllNodesWithText(text, substring = true, ignoreCase = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun inv(status: String, amountDue: Double = 0.0, dueDate: String = "") = Invoice(
        _id = "inv1",
        invoiceNumber = "1042",
        kinfolkName = "Halbrook",
        status = status,
        total = 40.0,
        amountDue = amountDue,
        date = "2026-10-03",
        dueDate = dueDate,
    )

    private fun render(invoice: Invoice, flags: FeatureFlags = FeatureFlags(), check: SemanticsNodeInteractionsProvider.() -> Unit) =
        runDesktopComposeUiTest {
            setContent {
                CompositionLocalProvider(LocalFeatureFlags provides flags) {
                    AuntieAppTheme(themeMode = ThemeMode.DARK) {
                        InvoiceRow(
                            invoice,
                            todayIso = today,
                            onInvoiceClick = null,
                            onReceipt = {},
                            onSendReminder = {},
                            onReviewSend = {},
                        )
                    }
                }
            }
            waitUntil(timeoutMillis = 10_000) { shown("#1042") }
            check()
        }

    @Test
    fun aCancelledRowWithNothingOwingOffersNoReceipt() = render(inv("cancelled")) {
        assertFalse(shown("Receipt"), "a receipt claims a payment")
        assertFalse(shown("Send reminder"))
        assertFalse(shown("paid Oct"), "the date line does not claim a payment either")
        assertTrue(shown("dated Oct 3"))
    }

    @Test
    fun creditAndZeroRowsOfferNothing() {
        for (status in listOf("credit", "redeemed", "zero", "quote")) {
            render(inv(status)) {
                assertFalse(shown("Receipt"), status)
                assertFalse(shown("Send reminder"), status)
                assertFalse(shown("Review & send"), status)
            }
        }
    }

    @Test
    fun aPaidRowOffersAReceipt() = render(inv("paid")) {
        assertTrue(shown("Receipt"))
        assertTrue(shown("paid Oct 3"))
        assertFalse(shown("reminded"), "no reminder line on a settled bill")
    }

    @Test
    fun anOpenRowWhoseAmountDueReadsZeroOffersAReminderNotAReceipt() = render(inv("open", dueDate = "2026-11-15")) {
        assertTrue(shown("Send reminder"))
        assertTrue(shown("reminded"), "last-reminded line beside the reminder button")
        assertFalse(shown("Receipt"))
        assertTrue(shown("due Nov 15"))
    }

    @Test
    fun aDraftRowOffersReviewAndSend() = render(inv("draft", amountDue = 40.0)) {
        assertTrue(shown("Review & send"))
        assertFalse(shown("Send reminder"))
        assertFalse(shown("reminded"))
    }

    @Test
    fun theReceiptKillSwitchStillShowsTheDisabledPill() =
        render(inv("paid"), flags = FeatureFlags(invoicesGenerateReceipt = false)) {
            assertTrue(shown("receipt · disabled"))
        }
}
