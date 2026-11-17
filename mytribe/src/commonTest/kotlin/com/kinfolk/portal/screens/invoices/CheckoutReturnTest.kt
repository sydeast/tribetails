package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2366: after paying by card from the MyTribe Android app, Stripe sent the
 * household to `/portal/payment-success`, a page the web portal does not have.
 *
 * Now both clients send the web portal's own invoice page, and this app checks
 * the bill itself when the household comes back to it: "Checking payment…"
 * until a fresh read shows it settled, never a paid claim of its own.
 */
class CheckoutReturnTest {

    private fun row(id: String, status: String, amountDue: Double, isPaid: Boolean): JsonObject = buildJsonObject {
        put("id", id)
        put("kinfolkId", "kin-1")
        put("total", 50.0)
        put("amountDue", amountDue)
        put("isPaid", isPaid)
        put("status", status)
    }

    private fun owed(): JsonObject = buildJsonObject {
        put("accountBalanceCents", 0L)
        put("open", buildJsonArray { add(row("inv-1", "open", 50.0, false)) })
        put("paid", buildJsonArray {})
        put("credits", buildJsonArray {})
    }

    private fun settled(): JsonObject = buildJsonObject {
        put("accountBalanceCents", 0L)
        put("open", buildJsonArray {})
        put("paid", buildJsonArray { add(row("inv-1", "paid", 0.0, true)) })
        put("credits", buildJsonArray {})
    }

    private val checkout = buildJsonObject {
        put("checkoutUrl", "https://checkout.stripe.com/c/pay/cs_test_1")
        put("sessionId", "cs_test_1")
        put("amountCents", 5000)
        put("currency", "usd")
    }

    private fun FakeFunctionsClient.reads(): Int = calls.count { it.first == "getMyInvoices" }

    /** Loads the list, then pays inv-1 and hands the checkout to a recording opener. */
    private suspend fun kotlinx.coroutines.test.TestScope.paidAtStripe(
        fake: FakeFunctionsClient,
        opened: MutableList<String> = mutableListOf(),
    ): InvoicesController {
        fake.stub("payInvoice", checkout)
        val c = InvoicesController("kin-1", PortalApi(fake), this) { opened += it }
        c.reload()
        val invoice = assertNotNull(c.find("inv-1"))
        c.startPay(invoice)
        advanceUntilIdle()
        return c
    }

    @Test
    fun `sends Stripe the web portal's invoice page, the marker on success and the bare page on cancel`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val opened = mutableListOf<String>()
        paidAtStripe(fake, opened)

        val payload = assertNotNull(fake.calls.last { it.first == "payInvoice" }.second)
        assertEquals("https://kinfolk.tribetails.com/invoices/inv-1?checkout=done", payload["successUrl"]?.jsonPrimitive?.content)
        assertEquals("https://kinfolk.tribetails.com/invoices/inv-1", payload["cancelUrl"]?.jsonPrimitive?.content)
        assertFalse(payload.toString().contains("/portal/payment-"), "the page that does not exist is gone")
        assertEquals(listOf("https://checkout.stripe.com/c/pay/cs_test_1"), opened)
    }

    @Test
    fun `coming back checks the bill, holds Pay back, and says paid only once the read does`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        assertNull(c.checkingPayment, "nothing is checked while the household is still at Stripe")

        // The webhook has not landed on the first two reads.
        fake.stubSequence("getMyInvoices", owed(), owed(), settled())
        c.onAppReturned()
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)
        assertNull(c.statusBanner, "no paid claim before the read shows it")
        assertFalse(assertNotNull(c.find("inv-1")).isPaid)

        advanceUntilIdle()
        assertNull(c.checkingPayment)
        assertNull(c.paymentNotSeen)
        assertTrue(assertNotNull(c.find("inv-1")).isPaid)
        assertEquals(PAYMENT_RECEIVED, c.statusBanner)
    }

    @Test
    fun `a check that runs out says the payment has not shown up, and Pay comes back`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        val before = fake.reads()

        c.onAppReturned()
        advanceUntilIdle()

        assertNull(c.checkingPayment)
        assertEquals("inv-1", c.paymentNotSeen)
        assertNull(c.statusBanner)
        // One read on return, then one every PAYMENT_CHECK_EVERY_MS for PAYMENT_CHECK_FOR_MS.
        assertEquals((PAYMENT_CHECK_FOR_MS / PAYMENT_CHECK_EVERY_MS + 1).toInt(), fake.reads() - before)
        assertTrue(offersPayment(assertNotNull(c.find("inv-1"))))
    }

    @Test
    fun `check again starts a fresh check and clears the ran-out line`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        c.onAppReturned()
        advanceUntilIdle()
        assertEquals("inv-1", c.paymentNotSeen)

        fake.stub("getMyInvoices", settled())
        c.checkPaymentAgain("inv-1")
        runCurrent()
        advanceUntilIdle()
        assertNull(c.paymentNotSeen)
        assertNull(c.checkingPayment)
        assertEquals(PAYMENT_RECEIVED, c.statusBanner)
    }

    @Test
    fun `focus coming back with no checkout handed off reads nothing`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}
        c.onAppReturned()
        advanceUntilIdle()
        assertEquals(0, fake.reads())
        assertNull(c.checkingPayment)
    }

    @Test
    fun `a checkout that never opened starts no check`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        fake.stubError("payInvoice", IllegalStateException("Card declined by Stripe."))
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}
        c.reload()
        c.startPay(assertNotNull(c.find("inv-1")))
        advanceUntilIdle()
        val before = fake.reads()

        c.onAppReturned()
        advanceUntilIdle()
        assertEquals(before, fake.reads())
        assertNull(c.checkingPayment)
    }

    @Test
    fun `the return is spent once, so a later focus change does not check again`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", settled())
        fake.stub("payInvoice", checkout)
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}
        c.reload()
        // Pay was tapped on a stale copy that still read owed.
        c.startPay(com.kinfolk.portal.portal.Invoice(
            id = "inv-1", kinfolkId = "kin-1", kinfolkName = null, client = null, total = 50.0, amountDue = 50.0,
            isPaid = false, status = com.kinfolk.portal.portal.InvoiceStatus.Open, date = null, dueDate = null,
            discount = null, terms = null, paymentsHistory = null, address = null, viewed = false,
            creditAmountCents = null, creditTarget = null, creditRedeemedAtMs = null, originalPaymentIntentId = null,
        ))
        advanceUntilIdle()
        c.onAppReturned()
        advanceUntilIdle()
        val after = fake.reads()
        c.onAppReturned()
        advanceUntilIdle()
        assertEquals(after, fake.reads())
    }

    @Test
    fun `an invoice id is percent-encoded into the path`() {
        assertEquals(
            "https://kinfolk.tribetails.com/invoices/INV%202027%2F1?checkout=done" to
                "https://kinfolk.tribetails.com/invoices/INV%202027%2F1",
            checkoutReturnUrls("INV 2027/1"),
        )
        assertEquals("abc-_.~09", encodePathSegment("abc-_.~09"))
    }
}
