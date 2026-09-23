package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PayMethod
import com.kinfolk.portal.portal.PayMethodKind
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

    /**
     * The controller's external hand-offs, captured instead of performed.
     *
     * Until this existed the checkout case below asserted nothing about the
     * URL and the controller handed it to the real platform opener, so
     * `./gradlew :jvmTest` browsed to
     * `https://checkout.stripe.com/c/pay/cs_test_1` twice, a fixture session
     * Stripe has never heard of, which it meets with "This link is
     * incomplete". Recording it is strictly more than the leak was doing:
     * every case below now says what the household's device was asked to open,
     * including the cases where the answer is "nothing".
     */
    private class RecordingOpener {
        val urls = mutableListOf<String>()
        fun opener(): (String) -> Unit = { urls += it }
    }

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
        val opened = RecordingOpener()
        val c = InvoicesController("kin-1", PortalApi(fake), this, opened.opener())
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

        // A checkout that never came back has no page to send anyone to.
        assertEquals(emptyList(), opened.urls, "a refused payInvoice must open nothing")
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
        val opened = RecordingOpener()
        val c = InvoicesController("kin-1", PortalApi(fake), this, opened.opener())
        val invoice = invoiceFixture()

        c.startPay(invoice)
        advanceUntilIdle()
        c.startPay(invoice)
        advanceUntilIdle()

        assertEquals(2, fake.calls.size)
        // THE LEAK, now an assertion. These two strings used to be two real
        // browser tabs per run of the suite; the recording fake is the only
        // reason they are a list instead.
        assertEquals(
            listOf(
                "https://checkout.stripe.com/c/pay/cs_test_1",
                "https://checkout.stripe.com/c/pay/cs_test_1",
            ),
            opened.urls,
            "startPay should hand the checkout URL to its injected opener, once per tap",
        )
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
        val opened = RecordingOpener()
        val c = InvoicesController("kin-1", PortalApi(fake), this, opened.opener())
        val invoiceA = invoiceFixture("inv-a")
        val invoiceB = invoiceFixture("inv-b")

        c.startPay(invoiceA)
        advanceUntilIdle()
        c.startPay(invoiceB)
        advanceUntilIdle()

        assertEquals(2, fake.calls.size)
        assertNotEquals(keyOf(fake.calls[0]), keyOf(fake.calls[1]))
        assertEquals(emptyList(), opened.urls)
    }

    /**
     * The OTHER two hand-offs this controller makes, which had the same hole.
     *
     * `startPayMethod`'s Link branch (Venmo / PayPal / Cash App) opens a URL
     * that arrived with the invoice payload, with no callable round-trip, so
     * nothing else in the controller records that it happened. Only the opener
     * sees it.
     */
    @Test
    fun `a link pay method opens exactly the url the invoice carried`() = runTest {
        val opened = RecordingOpener()
        val c = InvoicesController("kin-1", PortalApi(FakeFunctionsClient()), this, opened.opener())
        val venmo = PayMethod(id = "venmo", label = "Pay with Venmo", kind = PayMethodKind.Link, url = "https://venmo.com/u/auntie")

        c.startPayMethod(invoiceFixture(), venmo)
        advanceUntilIdle()

        assertEquals(listOf("https://venmo.com/u/auntie"), opened.urls)
    }

    /** An Instructions method is text, not a target: nothing to open, ever. */
    @Test
    fun `an instructions pay method opens nothing`() = runTest {
        val opened = RecordingOpener()
        val c = InvoicesController("kin-1", PortalApi(FakeFunctionsClient()), this, opened.opener())
        val zelle = PayMethod(
            id = "zelle",
            label = "Pay with Zelle",
            kind = PayMethodKind.Instructions,
            url = "https://zelle.example/should-never-open",
        )

        c.startPayMethod(invoiceFixture(), zelle)
        advanceUntilIdle()

        assertEquals(emptyList(), opened.urls)
    }

    @Test
    fun `downloading a pdf opens the rendered url and nothing else`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoicePdf", buildJsonObject { put("pdfUrl", "https://storage.example/inv-1.pdf") })
        val opened = RecordingOpener()
        val c = InvoicesController("kin-1", PortalApi(fake), this, opened.opener())

        c.startDownloadPdf(invoiceFixture())
        advanceUntilIdle()

        assertEquals(listOf("https://storage.example/inv-1.pdf"), opened.urls)
        assertEquals(null, c.error)
        assertEquals(null, c.downloadingPdf)
    }

    /** A server that renders nothing has nowhere to send the household. */
    @Test
    fun `a blank pdf url opens nothing`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoicePdf", buildJsonObject { put("pdfUrl", "") })
        val opened = RecordingOpener()
        val c = InvoicesController("kin-1", PortalApi(fake), this, opened.opener())

        c.startDownloadPdf(invoiceFixture())
        advanceUntilIdle()

        assertEquals(emptyList(), opened.urls)
    }
}
