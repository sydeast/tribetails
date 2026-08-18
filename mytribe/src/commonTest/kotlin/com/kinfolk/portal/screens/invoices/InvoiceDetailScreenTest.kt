@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceLineItem
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PayMethod
import com.kinfolk.portal.portal.PayMethodKind
import com.kinfolk.portal.portal.QuoteDecision
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class InvoiceDetailScreenTest {

    private fun openInvoice() = Invoice(
        id = "1042",
        kinfolkId = "3",
        kinfolkName = null,
        client = "Buddy (Nora)",
        total = 195.0,
        amountDue = 100.0,
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
    fun status_rendersFriendlyLabelNotEnumName() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen("The Foster", openInvoice(), onBack = {})
        }
        waitForIdle()
        // Same mapping as the list chips: Open reads as "Pending", never "Open".
        onNodeWithText("Pending").assertIsDisplayed()
        onNodeWithText("Open").assertDoesNotExist()
    }

    @Test
    fun lineItems_absent_rendersNoCoverageSection() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen("The Foster", openInvoice(), onBack = {})
        }
        waitForIdle()
        onNodeWithText("What this covers").assertDoesNotExist()
    }

    @Test
    fun lineItems_present_rendersCoverageRows() = runComposeUiTest {
        val invoice = openInvoice().copy(
            lineItems = listOf(
                InvoiceLineItem(sessionId = "s1", label = "Dog Walk", dateIso = "2026-06-01", amountCents = 4500L),
                InvoiceLineItem(sessionId = "s2", label = "Overnight Stay", dateIso = "2026-06-02", amountCents = 15000L),
            ),
        )
        setThemedContent {
            InvoiceDetailScreen("The Foster", invoice, onBack = {})
        }
        waitForIdle()
        onNodeWithText("What this covers").assertIsDisplayed()
        onNodeWithText("Dog Walk").assertIsDisplayed()
        onNodeWithText("2026-06-01").assertIsDisplayed()
        onNodeWithText("\$45.00").assertIsDisplayed()
        onNodeWithText("Overnight Stay").assertIsDisplayed()
        onNodeWithText("\$150.00").assertIsDisplayed()
    }

    @Test
    fun downloadPdf_shownEnabledAndFires() = runComposeUiTest {
        var clicked = false
        setThemedContent {
            InvoiceDetailScreen("The Foster", openInvoice(), onDownloadPdf = { clicked = true }, onBack = {})
        }
        waitForIdle()
        onNodeWithText("Download PDF").assertIsDisplayed()
        onNodeWithText("Download PDF").assertIsEnabled()
        // The dark "coming soon" stub text is gone now that it is real.
        onNodeWithText("PDF receipts are coming soon.").assertDoesNotExist()
        onNodeWithText("Download PDF").performClick()
        waitForIdle()
        assertTrue(clicked, "Download PDF should fire onDownloadPdf")
    }

    /**
     * PR30: one CTA per configured processor, and a link method (Venmo) states
     * the amount to send because it cannot enforce it — same contract as the
     * web `PayOptions` component's own tests.
     */
    @Test
    fun payOptions_rendersOneCtaPerConfiguredMethod() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                openInvoice(),
                payMethods = listOf(
                    PayMethod(id = "stripe", label = "Pay with Credit Card", kind = PayMethodKind.Checkout, url = null),
                    PayMethod(id = "venmo", label = "Pay with Venmo", kind = PayMethodKind.Link, url = "https://venmo.com/u/auntie"),
                ),
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithText("Pay with Credit Card").assertIsDisplayed()
        onNodeWithText("Pay with Venmo").assertIsDisplayed()
        onNodeWithText("Send \$100.00, then let your Auntie know it’s on its way.").assertIsDisplayed()
    }

    @Test
    fun payOptions_clickingAMethodFiresOnPayMethodWithThatMethod() = runComposeUiTest {
        var clicked: PayMethod? = null
        val venmo = PayMethod(id = "venmo", label = "Pay with Venmo", kind = PayMethodKind.Link, url = "https://venmo.com/u/auntie")
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                openInvoice(),
                payMethods = listOf(
                    PayMethod(id = "stripe", label = "Pay with Credit Card", kind = PayMethodKind.Checkout, url = null),
                    venmo,
                ),
                onPayMethod = { clicked = it },
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithText("Pay with Venmo").performClick()
        waitForIdle()
        assertEquals(venmo, clicked)
    }

    @Test
    fun payOptions_rendersNothingWhenNoMethodsConfigured() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen("The Foster", openInvoice(), payMethods = emptyList(), onBack = {})
        }
        waitForIdle()
        onNodeWithText("Pay with Credit Card").assertDoesNotExist()
    }
    // ---- Answering a quote (issue #385) ----
    //
    // Before this, a quote decoded as `Open` on this client: the household saw a
    // proposal presented as a pending bill, with a Pay button and no way to say
    // yes or no to it.
    private fun quote(
        decision: QuoteDecision? = null,
        decidedAtMs: Long? = null,
    ) = openInvoice().copy(
        status = InvoiceStatus.Quote,
        quoteDecision = decision,
        quoteDecidedAtMs = decidedAtMs,
    )
    @Test
    fun quote_offersBothAnswersAndNoPayButton() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                quote(),
                payMethods = listOf(PayMethod("stripe", "Pay with Credit Card", PayMethodKind.Checkout, null)),
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithText("Accept quote").assertIsDisplayed()
        onNodeWithText("Decline").assertIsDisplayed()
        onNodeWithText("Pay with Credit Card").assertDoesNotExist()
    }
    @Test
    fun quote_acceptAndDeclineReportWhichAnswerWasGiven() = runComposeUiTest {
        val answers = mutableListOf<Boolean>()
        setThemedContent {
            InvoiceDetailScreen("The Foster", quote(), onQuoteDecision = { answers.add(it) }, onBack = {})
        }
        waitForIdle()
        onNodeWithText("Accept quote").performClick()
        waitForIdle()
        assertEquals(listOf(true), answers)
    }
    @Test
    fun quote_declineReportsFalse() = runComposeUiTest {
        val answers = mutableListOf<Boolean>()
        setThemedContent {
            InvoiceDetailScreen("The Foster", quote(), onQuoteDecision = { answers.add(it) }, onBack = {})
        }
        waitForIdle()
        onNodeWithText("Decline").performClick()
        waitForIdle()
        assertEquals(listOf(false), answers)
    }
    @Test
    fun quote_bothButtonsGoDeadWhileAnAnswerIsInFlight() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen("The Foster", quote(), decidingQuote = true, onBack = {})
        }
        waitForIdle()
        onNodeWithText("Working…").assertIsNotEnabled()
        onNodeWithText("Decline").assertIsNotEnabled()
    }
    @Test
    fun quote_showsTheServersRefusalRatherThanSwallowingIt() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                quote(),
                quoteError = "This quote was only good through 2026-08-01.",
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithText("This quote was only good through 2026-08-01.").assertIsDisplayed()
    }
    @Test
    fun quote_alreadyDeclined_saysSoAndOffersNoButtons() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen("The Foster", quote(QuoteDecision.Denied, 1_755_000_000_000L), onBack = {})
        }
        waitForIdle()
        onNodeWithText("You declined this quote", substring = true).assertIsDisplayed()
        onNodeWithText("Accept quote").assertDoesNotExist()
        onNodeWithText("Decline").assertDoesNotExist()
    }
    @Test
    fun quote_accepted_isAnOpenInvoiceThatSaysWhoAcceptedIt() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen(
                "The Foster",
                openInvoice().copy(quoteDecision = QuoteDecision.Accepted, quoteDecidedAtMs = 1_755_000_000_000L),
                payMethods = listOf(PayMethod("stripe", "Pay with Credit Card", PayMethodKind.Checkout, null)),
                onBack = {},
            )
        }
        waitForIdle()
        onNodeWithText("You accepted this quote", substring = true).assertIsDisplayed()
        onNodeWithText("Pay with Credit Card").assertIsDisplayed()
    }
}
