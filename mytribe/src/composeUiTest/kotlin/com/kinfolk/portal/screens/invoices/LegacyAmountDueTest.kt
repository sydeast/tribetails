@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PayMethod
import com.kinfolk.portal.portal.PayMethodKind
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * READER 5, ANDROID HALF (#902): what the portal shows a household for a
 * MIGRATED invoice — one carrying a `total` and no `amountDue` at all.
 *
 * WHAT THEY USED TO SEE. `getMyInvoices` read the missing balance as 0 and
 * shipped `amountDue: 0`, so the detail screen's money row read "Amount Due
 * $0.00", the list row read "$0.00", and the Pay button was withheld because
 * `amountDue > 0.0` was false. A bill the office was still owed looked like
 * nothing to the only party who could pay it — while `onInvoiceAutoApply` drew
 * the same household's account credit against that same document.
 *
 * WHERE THE FIX LIVES. Not here. This client renders the number it is handed and
 * does not classify (CONTEXT.md; `getMyInvoices.ts#statusFromStamp` repeats it).
 * The shared rule (`functions/src/lib/amountDueRule.ts`) runs server-side, on the
 * raw document, where a missing field can still be told from a zero one. The
 * payload below is what that handler now sends for `{ status: 'sent', total: 40 }`,
 * pinned by `functions/test/amountDueRule.test.ts` ("reader 5 —
 * getMyInvoicesHandler"); this file is the other half of the pair, and the web
 * half is `mytribe/web/src/screens/InvoiceDetail.legacyAmountDue.test.tsx`.
 */
class LegacyAmountDueTest {

    /**
     * The migrated bill as the server now sends it: the balance DERIVED at the
     * full total, no `paidCents` because no settlement pass ever ran on it, and
     * `open` from the unstamped fail-soft. Before #902 the same document arrived
     * here with `amountDue: 0.0`.
     */
    private fun legacyInvoiceJson() = buildJsonObject {
        put("id", "lg1")
        put("kinfolkId", "3")
        put("amountDue", 40.0)
        put("total", 40.0)
        put("isPaid", false)
        put("status", "open")
        put("client", "Buddy (Nora)")
        put("date", "Mar 02, 2024")
        put("dueDate", "Mar 16, 2024")
    }

    private fun stubInvoices(fake: FakeFunctionsClient) {
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray { add(legacyInvoiceJson()) })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
    }

    private fun legacyInvoice(amountDue: Double = 40.0) = Invoice(
        id = "lg1",
        kinfolkId = "3",
        kinfolkName = null,
        client = "Buddy (Nora)",
        total = 40.0,
        amountDue = amountDue,
        isPaid = false,
        status = InvoiceStatus.Open,
        date = "Mar 02, 2024",
        dueDate = "Mar 16, 2024",
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

    private val stripe = PayMethod("stripe", "Pay with Credit Card", PayMethodKind.Checkout, null)

    @Test
    fun theDerivedBalanceSurvivesTheDecode() = runTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake)
        val inv = PortalApi(fake).getMyInvoices("3").open.single()
        assertEquals(40.0, inv.amountDue)
        assertEquals(InvoiceStatus.Open, inv.status)
    }

    @Test
    fun detailScreenShowsTheBillAsOwed_notAsZero() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen("The Foster", legacyInvoice(), payMethods = listOf(stripe), onBack = {})
        }
        waitForIdle()
        onNodeWithText("Amount Due").assertIsDisplayed()
        // TWO nodes, and that is the assertion: the Amount Due row and the Total
        // row both read $40.00, because a migrated bill nobody has paid owes its
        // whole total. Before #902 the first of them read $0.00.
        onAllNodesWithText("\$40.00").assertCountEquals(2)
        onNodeWithText("\$0.00").assertDoesNotExist()
        onNodeWithText("Paid").assertDoesNotExist()
    }

    @Test
    fun andOffersAWayToPayIt() = runComposeUiTest {
        setThemedContent {
            InvoiceDetailScreen("The Foster", legacyInvoice(), payMethods = listOf(stripe), onBack = {})
        }
        waitForIdle()
        onNodeWithText("Pay with Credit Card").assertIsDisplayed()
    }

    @Test
    fun theListRowShowsTheSameFigureAndAPayButton() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake)
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("\$40.00").assertIsDisplayed()
        onNodeWithText("Pay \$40.00").assertIsDisplayed()
    }
}
