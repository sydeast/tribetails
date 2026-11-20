package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
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
 * This app checks the bill itself when the household comes back to it:
 * "Checking payment…" until a fresh read shows it settled, never a paid claim
 * of its own.
 *
 * #2401: the address it sends is now one this app claims, `/app/invoices/{id}`,
 * so the phone opens the app on the invoice. #2366 had sent the web portal's
 * own invoice page, which put a sign-in screen in front of a household who is
 * not signed in on the web. `CheckoutReturnLinkTest` covers the link itself.
 */
class CheckoutReturnTest {
    // The return-link holder is one per app; no test may leave a link waiting for the next.
    @BeforeTest
    fun noLinkWaiting() {
        PendingCheckoutReturn.clear()
    }
    @AfterTest
    fun leaveNoLinkWaiting() {
        PendingCheckoutReturn.clear()
    }

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
    fun `sends Stripe the address this app claims, the marker on success and the bare address on cancel`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val opened = mutableListOf<String>()
        paidAtStripe(fake, opened)

        val payload = assertNotNull(fake.calls.last { it.first == "payInvoice" }.second)
        assertEquals("https://kinfolk.tribetails.com/app/invoices/inv-1?checkout=done", payload["successUrl"]?.jsonPrimitive?.content)
        assertEquals("https://kinfolk.tribetails.com/app/invoices/inv-1", payload["cancelUrl"]?.jsonPrimitive?.content)
        assertFalse(payload.toString().contains("/portal/payment-"), "the page that does not exist is gone")
        // #2401: not the web portal's own invoice page, which needs a web sign-in.
        assertFalse(payload.toString().contains("tribetails.com/invoices/"), "the web portal's page is not where the app returns to")
        // The server refuses anything off the portal's origin, the app's own scheme included.
        assertTrue(payload["successUrl"]!!.jsonPrimitive.content.startsWith("https://kinfolk.tribetails.com/"))
        assertTrue(payload["cancelUrl"]!!.jsonPrimitive.content.startsWith("https://kinfolk.tribetails.com/"))
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
            "https://kinfolk.tribetails.com/app/invoices/INV%202027%2F1?checkout=done" to
                "https://kinfolk.tribetails.com/app/invoices/INV%202027%2F1",
            checkoutReturnUrls("INV 2027/1"),
        )
        assertEquals("abc-_.~09", encodePathSegment("abc-_.~09"))
    }

    // ── #2401: the return link opens the app on the invoice ──

    private val finishedLink = CheckoutReturn("inv-1", finished = true)
    private val cancelledLink = CheckoutReturn("inv-1", finished = false)
    private val fullCheck = (PAYMENT_CHECK_FOR_MS / PAYMENT_CHECK_EVERY_MS + 1).toInt()
    private fun FakeFunctionsClient.pays(): Int = calls.count { it.first == "payInvoice" }

    @Test
    fun `a finished return link checks the bill by itself, with no hand-off remembered`() = runTest {
        // Android ended the app while the household was at Stripe: a new
        // controller that never handed anything off.
        val fake = FakeFunctionsClient()
        fake.stubSequence("getMyInvoices", owed(), settled())
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}

        c.onCheckoutReturn(finishedLink)
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)
        assertNull(c.statusBanner, "the link never says paid; the read does")
        assertFalse(assertNotNull(c.find("inv-1")).isPaid)

        advanceUntilIdle()
        assertNull(c.checkingPayment)
        assertNull(c.paymentNotSeen)
        assertTrue(assertNotNull(c.find("inv-1")).isPaid)
        assertEquals(PAYMENT_RECEIVED, c.statusBanner)
    }

    @Test
    fun `a finished return link for a bill that never shows paid ends like any other check`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}

        c.onCheckoutReturn(finishedLink)
        advanceUntilIdle()
        assertNull(c.checkingPayment)
        assertEquals("inv-1", c.paymentNotSeen)
        assertNull(c.statusBanner, "a link alone is never a paid claim")
        assertEquals(fullCheck, fake.reads())
    }

    @Test
    fun `a cancelled return link starts no check and leaves Pay on offer`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        val before = fake.reads()

        c.onCheckoutReturn(cancelledLink)
        runCurrent()
        assertNull(c.checkingPayment)
        advanceUntilIdle()

        assertNull(c.checkingPayment)
        assertNull(c.paymentNotSeen)
        assertNull(c.paymentNotChecked)
        assertNull(c.statusBanner)
        assertEquals(1, fake.reads() - before, "one read, to show the bill as it stands")
        assertTrue(offersPayment(assertNotNull(c.find("inv-1"))))

        // The hand-off is spent: focus coming back afterwards checks nothing.
        c.onAppReturned()
        advanceUntilIdle()
        assertEquals(1, fake.reads() - before)
        assertNull(c.checkingPayment)
    }

    @Test
    fun `focus first and then the finished link make one check, not two`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        val before = fake.reads()

        c.onAppReturned()
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)
        c.onCheckoutReturn(finishedLink)
        runCurrent()
        assertEquals(1, fake.reads() - before, "the link did not start the check over")

        advanceUntilIdle()
        assertEquals(fullCheck, fake.reads() - before)
        assertEquals("inv-1", c.paymentNotSeen)
    }

    @Test
    fun `the finished link first and then focus make one check, not two`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        val before = fake.reads()

        c.onCheckoutReturn(finishedLink)
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)
        c.onAppReturned()
        runCurrent()
        assertEquals(1, fake.reads() - before, "focus found the hand-off already answered")

        advanceUntilIdle()
        assertEquals(fullCheck, fake.reads() - before)
    }

    @Test
    fun `focus first and then the cancelled link stop the check at once`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        val before = fake.reads()

        c.onAppReturned()
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)

        c.onCheckoutReturn(cancelledLink)
        assertNull(c.checkingPayment, "Pay is not held back for a minute over a payment nobody made")
        advanceUntilIdle()

        assertNull(c.checkingPayment)
        assertNull(c.paymentNotSeen, "nothing is said about a payment that was never made")
        assertNull(c.paymentNotChecked)
        // The check's first read, and the one read after the cancel. No more.
        assertEquals(2, fake.reads() - before)
        assertTrue(offersPayment(assertNotNull(c.find("inv-1"))))
    }

    @Test
    fun `a link still waiting to open makes focus stand down, and the link then decides`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        val before = fake.reads()

        // MainActivity has the link; the nav host has not taken it yet.
        PendingCheckoutReturn.offer(cancelledLink)
        c.onAppReturned()
        advanceUntilIdle()
        assertEquals(before, fake.reads(), "focus did not start a check the link is about to call off")
        assertNull(c.checkingPayment)

        c.onCheckoutReturn(assertNotNull(PendingCheckoutReturn.take()))
        advanceUntilIdle()
        assertNull(c.checkingPayment)
        assertEquals(1, fake.reads() - before)

        // And nothing is left over for a later focus change.
        c.onAppReturned()
        advanceUntilIdle()
        assertEquals(1, fake.reads() - before)
    }

    @Test
    fun `a link waiting for a different invoice does not stop focus checking this one`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)

        PendingCheckoutReturn.offer(CheckoutReturn("inv-9", finished = false))
        c.onAppReturned()
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)
        advanceUntilIdle()
    }

    @Test
    fun `when a second window took the cancelled link, the window underneath checks nothing`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        // The window the household paid from, and the one Android opened the link in.
        val paidFrom = paidAtStripe(fake)
        val openedByLink = InvoicesController("kin-1", PortalApi(fake), this) {}
        openedByLink.onCheckoutReturn(cancelledLink)
        advanceUntilIdle()
        val before = fake.reads()

        // The household backs out to the first window.
        paidFrom.onAppReturned()
        runCurrent()
        assertNull(paidFrom.checkingPayment)
        advanceUntilIdle()
        assertNull(paidFrom.checkingPayment)
        assertNull(paidFrom.paymentNotSeen)
        assertEquals(1, fake.reads() - before, "one read, to show the bill as it stands")
        assertTrue(offersPayment(assertNotNull(paidFrom.find("inv-1"))))
    }

    @Test
    fun `when a second window took the finished link, the window underneath still checks the bill itself`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val paidFrom = paidAtStripe(fake)
        // Android opened the link in a second window. The webhook has not landed.
        val openedByLink = InvoicesController("kin-1", PortalApi(fake), this) {}
        openedByLink.onCheckoutReturn(finishedLink)
        runCurrent()
        assertEquals("inv-1", openedByLink.checkingPayment)

        // The household backs out to the first window while the payment is
        // still landing. That window must not show Pay on the strength of one read.
        val before = fake.reads()
        paidFrom.onAppReturned()
        runCurrent()
        assertEquals("inv-1", paidFrom.checkingPayment, "Pay is held back here too")
        assertNull(paidFrom.statusBanner)
        assertEquals(1, fake.reads() - before)

        fake.stub("getMyInvoices", settled())
        advanceUntilIdle()
        assertNull(paidFrom.checkingPayment)
        assertNull(paidFrom.paymentNotSeen)
        assertTrue(assertNotNull(paidFrom.find("inv-1")).isPaid)
        assertEquals(PAYMENT_RECEIVED, paidFrom.statusBanner)
    }

    @Test
    fun `once a finished link was seen, a later cancelled link does not make the window underneath stand down`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val paidFrom = paidAtStripe(fake)
        val openedByLink = InvoicesController("kin-1", PortalApi(fake), this) {}
        openedByLink.onCheckoutReturn(finishedLink)
        runCurrent()
        // A stale or forged cancel for the same checkout.
        openedByLink.onCheckoutReturn(cancelledLink)
        runCurrent()
        assertEquals("inv-1", openedByLink.checkingPayment, "the cancel did not call off the check the finished link started")

        paidFrom.onAppReturned()
        runCurrent()
        assertEquals("inv-1", paidFrom.checkingPayment)
        advanceUntilIdle()
    }

    @Test
    fun `a cancelled link cannot call off a check that a finished link started`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        val before = fake.reads()

        c.onCheckoutReturn(finishedLink)
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)
        c.onCheckoutReturn(cancelledLink)
        runCurrent()
        assertEquals("inv-1", c.checkingPayment, "Pay stays held back while the payment may still be landing")

        // The check runs its full course; the cancel cost one extra read and nothing else.
        advanceUntilIdle()
        assertEquals("inv-1", c.paymentNotSeen)
        assertEquals(fullCheck + 1, fake.reads() - before)
    }

    @Test
    fun `a cancelled link cannot call off a check that a finished link confirmed`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)

        // Focus started it, then Stripe's success address confirmed it.
        c.onAppReturned()
        runCurrent()
        c.onCheckoutReturn(finishedLink)
        runCurrent()
        c.onCheckoutReturn(cancelledLink)
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)
        advanceUntilIdle()
    }

    @Test
    fun `a cancelled link does not call off a check the household asked for`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        c.onAppReturned()
        advanceUntilIdle()
        assertEquals("inv-1", c.paymentNotSeen)

        c.checkPaymentAgain("inv-1")
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)
        c.onCheckoutReturn(cancelledLink)
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)
        advanceUntilIdle()
    }

    @Test
    fun `a cancelled link and then a finished one is a payment to check`() = runTest {
        // The household backed out of checkout, went forward again and paid.
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val paidFrom = paidAtStripe(fake)
        val openedByLink = InvoicesController("kin-1", PortalApi(fake), this) {}
        openedByLink.onCheckoutReturn(cancelledLink)
        runCurrent()
        assertNull(openedByLink.checkingPayment)

        openedByLink.onCheckoutReturn(finishedLink)
        runCurrent()
        assertEquals("inv-1", openedByLink.checkingPayment)

        // And the window underneath no longer treats the checkout as cancelled.
        paidFrom.onAppReturned()
        runCurrent()
        assertEquals("inv-1", paidFrom.checkingPayment)
        advanceUntilIdle()
    }

    @Test
    fun `a new checkout for the same invoice is checked again, whatever an earlier link said`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        c.onCheckoutReturn(cancelledLink)
        advanceUntilIdle()

        // The household pays again, and this time comes back by hand.
        c.startPay(assertNotNull(c.find("inv-1")))
        advanceUntilIdle()
        assertEquals(2, fake.pays())
        c.onAppReturned()
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)
        advanceUntilIdle()
    }

    // ── #2402: a read that fails while the payment is checked ──

    @Test
    fun `a read that fails during the check keeps the list and the cue, and the next tick reads again`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        c.onAppReturned()
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)

        fake.stubError("getMyInvoices", IllegalStateException("network down"))
        val before = fake.reads()
        advanceTimeBy(PAYMENT_CHECK_EVERY_MS)
        runCurrent()
        assertEquals(1, fake.reads() - before, "the failed read happened")
        assertEquals("inv-1", c.checkingPayment, "the check cue stays")
        assertNull(c.error, "a failed re-read is not reported over a list already in hand")
        assertNotNull(c.find("inv-1"), "the invoice already loaded is kept")
        assertNull(c.statusBanner)

        fake.stub("getMyInvoices", settled())
        advanceUntilIdle()
        assertNull(c.checkingPayment)
        assertNull(c.paymentNotSeen)
        assertNull(c.paymentNotChecked)
        assertEquals(PAYMENT_RECEIVED, c.statusBanner)
    }

    @Test
    fun `when no read gets through, it says the payment could not be checked and keeps Pay held back`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        fake.stubError("getMyInvoices", IllegalStateException("network down"))

        c.onAppReturned()
        advanceUntilIdle()
        assertNull(c.checkingPayment)
        assertEquals("inv-1", c.paymentNotChecked)
        assertNull(c.paymentNotSeen, "has-not-shown-up claims a read, and there was none")
        assertNull(c.error)
        assertNull(c.statusBanner)
        assertNotNull(c.find("inv-1"))

        // No read since the return says the bill is still owed, so Pay is refused.
        val paysBefore = fake.pays()
        c.startPay(assertNotNull(c.find("inv-1")))
        advanceUntilIdle()
        assertEquals(paysBefore, fake.pays())
        assertNull(c.paying)

        // Check again, and this time the read works.
        fake.stub("getMyInvoices", settled())
        c.checkPaymentAgain("inv-1")
        advanceUntilIdle()
        assertNull(c.paymentNotChecked)
        assertNull(c.checkingPayment)
        assertEquals(PAYMENT_RECEIVED, c.statusBanner)
    }

    @Test
    fun `a later read that works and still says owed brings Pay back, with the not-shown-up line`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        fake.stubError("getMyInvoices", IllegalStateException("network down"))
        c.onAppReturned()
        advanceUntilIdle()
        assertEquals("inv-1", c.paymentNotChecked)

        fake.stub("getMyInvoices", owed())
        c.reload()
        assertNull(c.paymentNotChecked)
        assertEquals("inv-1", c.paymentNotSeen)
        assertNull(c.statusBanner)

        val paysBefore = fake.pays()
        c.startPay(assertNotNull(c.find("inv-1")))
        advanceUntilIdle()
        assertEquals(paysBefore + 1, fake.pays())
    }

    @Test
    fun `a later read that works and says paid says so`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        fake.stubError("getMyInvoices", IllegalStateException("network down"))
        c.onAppReturned()
        advanceUntilIdle()
        assertEquals("inv-1", c.paymentNotChecked)

        fake.stub("getMyInvoices", settled())
        c.reload()
        assertNull(c.paymentNotChecked)
        assertNull(c.paymentNotSeen)
        assertEquals(PAYMENT_RECEIVED, c.statusBanner)
    }

    @Test
    fun `with nothing loaded yet, a read that fails is still reported`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyInvoices", IllegalStateException("network down"))
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}

        c.onCheckoutReturn(finishedLink)
        runCurrent()
        assertNull(c.data)
        assertEquals("network down", c.error, "there is nothing else to show")
        advanceUntilIdle()
        assertEquals("inv-1", c.paymentNotChecked)
        assertNull(c.paymentNotSeen)
    }

    @Test
    fun `an ordinary reload that fails is reported as before`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}
        c.reload()
        fake.stubError("getMyInvoices", IllegalStateException("network down"))
        c.reload()
        assertEquals("network down", c.error)
        assertNotNull(c.find("inv-1"))
    }

    @Test
    fun `Pay is refused while the payment is being checked`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", owed())
        val c = paidAtStripe(fake)
        c.onAppReturned()
        runCurrent()
        assertEquals("inv-1", c.checkingPayment)

        val paysBefore = fake.pays()
        c.startPay(assertNotNull(c.find("inv-1")))
        runCurrent()
        assertEquals(paysBefore, fake.pays())
        advanceUntilIdle()
    }

    @Test
    fun `the list row checks again, and never pays, after a check that read nothing`() {
        assertEquals(
            OpenRowAction("Checking payment…", enabled = false, checksAgain = false),
            openRowAction(checking = true, notChecked = false, paying = false, amountDue = 50.0),
        )
        assertEquals(
            OpenRowAction("Check payment again", enabled = true, checksAgain = true),
            openRowAction(checking = false, notChecked = true, paying = false, amountDue = 50.0),
        )
        // Checking wins over everything, and a held row never offers Pay.
        assertEquals(
            OpenRowAction("Checking payment…", enabled = false, checksAgain = false),
            openRowAction(checking = true, notChecked = true, paying = true, amountDue = 50.0),
        )
        assertEquals(
            OpenRowAction("Opening checkout…", enabled = false, checksAgain = false),
            openRowAction(checking = false, notChecked = false, paying = true, amountDue = 50.0),
        )
        assertEquals(
            OpenRowAction("Pay \$50.00", enabled = true, checksAgain = false),
            openRowAction(checking = false, notChecked = false, paying = false, amountDue = 50.0),
        )
        assertFalse(openRowAction(checking = false, notChecked = false, paying = false, amountDue = 0.0).enabled)
    }
}
