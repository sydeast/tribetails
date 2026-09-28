package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.CreditTarget
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * D-2026-09-28-BILLING-ACCESS-PAYS (#1036): billing access includes paying,
 * using credit and answering quotes, so a SECONDARY the PRIMARY granted billing
 * does all three.
 *
 * The shared controller behind the Android and desktop invoice screens has no
 * notion of role: it is reached only through the Invoices destination, which
 * the shell draws on `getMyHome.billingAccess` (`ShellNav.wideLinksFor`). These
 * pin the two halves of that: every money action goes straight to its callable
 * with nothing asking "is this the primary", and when the server refuses a
 * member without billing access the controller shows the server's own sentence.
 */
class BillingAccessPaysControllerTest {

    private val refusal = "Billing access is required to pay, use credit, answer quotes or manage cards."

    private fun invoice(id: String = "inv-1", status: InvoiceStatus = InvoiceStatus.Open): Invoice = Invoice(
        id = id,
        kinfolkId = "kin-1",
        kinfolkName = null,
        client = null,
        total = 50.0,
        amountDue = if (status == InvoiceStatus.Credit) -20.0 else 50.0,
        isPaid = false,
        status = status,
        date = null,
        dueDate = null,
        discount = null,
        terms = null,
        paymentsHistory = null,
        address = null,
        viewed = false,
        creditAmountCents = if (status == InvoiceStatus.Credit) 2000L else null,
        creditTarget = null,
        creditRedeemedAtMs = null,
        originalPaymentIntentId = null,
    )

    @Test
    fun `pay, quote and credit each reach their callable with no role check in between`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("payInvoice", buildJsonObject {
            put("checkoutUrl", "https://checkout.stripe.com/c/pay/cs_1")
            put("sessionId", "cs_1")
        })
        fake.stub("acceptQuote", buildJsonObject {
            put("ok", true)
            put("invoiceId", "q-1")
            put("status", "open")
        })
        fake.stub("redeemCredit", buildJsonObject {
            put("ok", true)
            put("redeemedAmountCents", 2000)
            put("target", "accountBalance")
            put("newAccountBalanceCents", JsonNull)
        })
        val opened = mutableListOf<String>()
        val c = InvoicesController("kin-1", PortalApi(fake), this) { opened += it }

        c.startPay(invoice())
        advanceUntilIdle()
        c.startQuoteDecision(invoice(id = "q-1", status = InvoiceStatus.Quote), accept = true)
        advanceUntilIdle()
        c.startRedeem(invoice(id = "c-1", status = InvoiceStatus.Credit), CreditTarget.AccountBalance)
        advanceUntilIdle()

        val names = fake.calls.map { it.first }
        assertTrue("payInvoice" in names, "payInvoice was not called: $names")
        assertTrue("acceptQuote" in names, "acceptQuote was not called: $names")
        assertTrue("redeemCredit" in names, "redeemCredit was not called: $names")
        assertEquals(listOf("https://checkout.stripe.com/c/pay/cs_1"), opened)
    }

    @Test
    fun `a member without billing access sees the server's refusal on pay`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("payInvoice", IllegalStateException(refusal))
        val c = InvoicesController("kin-1", PortalApi(fake), this) { }
        c.startPay(invoice())
        advanceUntilIdle()
        assertEquals(refusal, c.error)
    }

    @Test
    fun `a member without billing access sees the server's refusal beside the quote`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("denyQuote", IllegalStateException(refusal))
        val c = InvoicesController("kin-1", PortalApi(fake), this) { }
        c.startQuoteDecision(invoice(id = "q-1", status = InvoiceStatus.Quote), accept = false)
        advanceUntilIdle()
        assertEquals(refusal, c.quoteErrorFor("q-1"))
    }

    @Test
    fun `a member without billing access sees the server's refusal on use credit`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("redeemCredit", IllegalStateException(refusal))
        val c = InvoicesController("kin-1", PortalApi(fake), this) { }
        c.startRedeem(invoice(id = "c-1", status = InvoiceStatus.Credit), CreditTarget.AccountBalance)
        advanceUntilIdle()
        assertTrue(c.statusBanner?.contains(refusal) == true, "banner was '${c.statusBanner}'")
    }
}
