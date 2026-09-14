package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * #825, the portal Android app's CONTROLLER half.
 *
 * `CheckoutIdempotencyPortalApiTest` pins the wire shape of the key
 * (`PortalApi.payInvoice` puts it on the payload when it is given one, and
 * only then). It does not touch who DECIDES to reuse one, which is
 * `InvoicesController.startPay`'s `checkoutKeys` map. This is the mirror of
 * the web portal's `InvoiceDetail.test.tsx` "holds one checkout key across a
 * re-tap after a failure": the server's own session reuse (#826) can only
 * hand back a session it can find, through the id it writes AFTER Stripe
 * replies, so a call whose reply was lost on the way back stored nothing:
 * the next tap needs to carry the SAME key for that case to be closed.
 */
class InvoicesControllerTest {

    private fun invoiceFixture(id: String = "inv-1"): Invoice = Invoice(
        id = id,
        kinfolkId = "kin-1",
        kinfolkName = null,
        client = null,
        total = 50.0,
        amountDue = 50.0,
        isPaid = false,
        status = InvoiceStatus.Open,
        date = null,
        dueDate = null,
        discount = null,
        terms = null,
        paymentsHistory = null,
        address = null,
        viewed = false,
        creditAmountCents = null,
        creditTarget = null,
        creditRedeemedAtMs = null,
        originalPaymentIntentId = null,
    )

    private fun keyOf(call: Pair<String, kotlinx.serialization.json.JsonObject?>): String? =
        call.second?.get("idempotencyKey")?.jsonPrimitive?.content

    @Test
    fun `holds one checkout key across a re-tap after a failure`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("payInvoice", IllegalStateException("Card declined by Stripe."))
        val c = InvoicesController("kin-1", PortalApi(fake), this)
        val invoice = invoiceFixture()

        c.startPay(invoice)
        advanceUntilIdle()
        assertEquals("Card declined by Stripe.", c.error)
        assertEquals(1, fake.calls.size)
        val firstKey = keyOf(fake.calls[0])
        assertTrue(
            firstKey != null && Regex("^chk_[0-9]{10,16}_[a-z0-9]{1,16}$").matches(firstKey),
            "first call's key was '$firstKey', which the callable's zod guard would refuse",
        )

        c.startPay(invoice)
        advanceUntilIdle()
        assertEquals(2, fake.calls.size)
        assertEquals(firstKey, keyOf(fake.calls[1]))
    }

    @Test
    fun `a completed checkout drops the key, so paying the SAME bill again mints a new one`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub(
            "payInvoice",
            buildJsonObject {
                put("checkoutUrl", "https://checkout.stripe.com/c/pay/cs_test_1")
                put("sessionId", "cs_test_1")
                put("amountCents", 5000)
                put("currency", "usd")
            },
        )
        val c = InvoicesController("kin-1", PortalApi(fake), this)
        val invoice = invoiceFixture()

        c.startPay(invoice)
        advanceUntilIdle()
        c.startPay(invoice)
        advanceUntilIdle()

        assertEquals(2, fake.calls.size)
        // Unlike the failure case above: a checkout that actually opened must
        // not hand a LATER, independent attempt at the same bill a key Stripe
        // already has a session for (the body would differ and Stripe would
        // refuse it; see CheckoutIdempotency.kt).
        assertNotEquals(keyOf(fake.calls[0]), keyOf(fake.calls[1]))
    }

    @Test
    fun `two different invoices never share a key, even both mid-retry`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("payInvoice", IllegalStateException("Card declined by Stripe."))
        val c = InvoicesController("kin-1", PortalApi(fake), this)
        val invoiceA = invoiceFixture("inv-a")
        val invoiceB = invoiceFixture("inv-b")

        c.startPay(invoiceA)
        advanceUntilIdle()
        c.startPay(invoiceB)
        advanceUntilIdle()

        assertEquals(2, fake.calls.size)
        assertNotEquals(keyOf(fake.calls[0]), keyOf(fake.calls[1]))
    }
}
