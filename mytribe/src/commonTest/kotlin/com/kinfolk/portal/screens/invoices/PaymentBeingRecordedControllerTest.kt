package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
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
 * #2437: A PAYMENT ON THIS INVOICE HAS FINISHED AT STRIPE AND IS NOT RECORDED
 * YET, and Pay is pressed from a screen that does not know: a second window
 * of this app, or a return by hand. `payInvoice` opens no checkout and
 * answers with a sentence.
 *
 * The controller answers that refusal by checking the payment, the way it
 * does after a return from Stripe: Pay is held back, the sentence is shown
 * where Pay was (and not as an error as well), and the bill is read again
 * until the payment shows. `PaymentBeingRecordedTest` (composeUiTest) pins
 * what the two screens draw.
 */
class PaymentBeingRecordedControllerTest {
    @BeforeTest
    fun noLinkWaiting() {
        PendingCheckoutReturn.clear()
    }

    @AfterTest
    fun leaveNoLinkWaiting() {
        PendingCheckoutReturn.clear()
    }

    private val sentence = "A payment on this invoice is still being recorded. Check again in a minute."

    private fun row(status: String, amountDue: Double, isPaid: Boolean): JsonObject = buildJsonObject {
        put("id", "inv-1")
        put("kinfolkId", "kin-1")
        put("total", 50.0)
        put("amountDue", amountDue)
        put("isPaid", isPaid)
        put("status", status)
    }

    private fun owed(): JsonObject = buildJsonObject {
        put("accountBalanceCents", 0L)
        put("open", buildJsonArray { add(row("open", 50.0, false)) })
        put("paid", buildJsonArray {})
        put("credits", buildJsonArray {})
    }

    private fun settled(): JsonObject = buildJsonObject {
        put("accountBalanceCents", 0L)
        put("open", buildJsonArray {})
        put("paid", buildJsonArray { add(row("paid", 0.0, true)) })
        put("credits", buildJsonArray {})
    }

    private fun FakeFunctionsClient.pays(): Int = calls.count { it.first == "payInvoice" }

    /** Loads the list, then presses Pay on inv-1 against a server that refuses with [refusal]. */
    private suspend fun TestScope.refusedPay(
        fake: FakeFunctionsClient,
        refusal: Throwable,
        opened: MutableList<String> = mutableListOf(),
    ): InvoicesController {
        fake.stub("getMyInvoices", owed())
        fake.stubError("payInvoice", refusal)
        val c = InvoicesController("kin-1", PortalApi(fake), this) { opened += it }
        c.reload()
        c.startPay(assertNotNull(c.find("inv-1")))
        runCurrent()
        return c
    }

    @Test
    fun `the sentence this app looks for is the one the server sends`() {
        assertEquals(sentence, PAYMENT_BEING_RECORDED)
    }

    @Test
    fun `the refusal is known by its sentence, however the error reached this app`() {
        // The Android SDK hands over the server's message as it is.
        assertTrue(isPaymentBeingRecorded(IllegalStateException(sentence)))
        // The desktop build wraps the whole reply.
        assertTrue(
            isPaymentBeingRecorded(
                RuntimeException(
                    "Firebase REST call payInvoice failed: HTTP 400 — {\"error\":{\"message\":\"$sentence\"," +
                        "\"status\":\"FAILED_PRECONDITION\",\"details\":{\"code\":\"payment_being_recorded\"}}}",
                ),
            ),
        )
        assertFalse(isPaymentBeingRecorded(IllegalStateException(PAID_INVOICE_REFUSAL)))
        assertFalse(isPaymentBeingRecorded(IllegalStateException("INTERNAL")))
        assertFalse(isPaymentBeingRecorded(RuntimeException()))
    }

    @Test
    fun `a refused Pay holds Pay back, shows the sentence in its place and reports no error`() = runTest {
        val fake = FakeFunctionsClient()
        val opened = mutableListOf<String>()
        val c = refusedPay(fake, IllegalStateException(sentence), opened)

        assertEquals("inv-1", c.paymentBeingRecorded)
        assertEquals("inv-1", c.checkingPayment)
        // Said once, where Pay was. Not a second time as an error.
        assertNull(c.error)
        assertNull(c.payErrorFor("inv-1"))
        assertNull(c.statusBanner, "no paid claim before a read shows it")
        assertTrue(opened.isEmpty(), "a page was opened: $opened")

        // A second press while the check runs sends nothing.
        c.startPay(assertNotNull(c.find("inv-1")))
        runCurrent()
        assertEquals(1, fake.pays())

        c.checkPaymentAgain("inv-1")
        runCurrent()
        assertNull(c.paymentBeingRecorded, "a check the household asked for is the ordinary check")
        assertEquals("inv-1", c.checkingPayment)
    }

    @Test
    fun `the bill is read again until the payment shows, and paid is said only then`() = runTest {
        val fake = FakeFunctionsClient()
        val c = refusedPay(fake, IllegalStateException(sentence))
        // The webhook has not landed on the next two reads.
        fake.stubSequence("getMyInvoices", owed(), owed(), settled())

        advanceUntilIdle()

        assertNull(c.checkingPayment)
        assertNull(c.paymentBeingRecorded)
        assertNull(c.paymentNotSeen)
        assertNull(c.error)
        assertNull(c.payErrorFor("inv-1"))
        assertTrue(assertNotNull(c.find("inv-1")).isPaid)
        assertEquals(PAYMENT_RECEIVED, c.statusBanner)
    }

    @Test
    fun `a payment that has not shown in time gives Pay back, and the server decides again`() = runTest {
        val fake = FakeFunctionsClient()
        val c = refusedPay(fake, IllegalStateException(sentence))

        advanceUntilIdle()

        assertNull(c.checkingPayment)
        assertNull(c.paymentBeingRecorded, "the sentence leaves with the check")
        assertEquals("inv-1", c.paymentNotSeen)
        assertNull(c.statusBanner)
        assertNull(c.error)
        assertNull(c.payErrorFor("inv-1"))
        assertTrue(offersPayment(assertNotNull(c.find("inv-1"))))

        // The next press reaches the server, which refuses again while the payment is unrecorded.
        c.startPay(assertNotNull(c.find("inv-1")))
        runCurrent()
        assertEquals(2, fake.pays())
        assertEquals("inv-1", c.paymentBeingRecorded)
        assertEquals("inv-1", c.checkingPayment)
        assertNull(c.paymentNotSeen)
    }

    @Test
    fun `any other refusal is still reported in the server's own words, and starts no check`() = runTest {
        // This is also what a build from before this change does with the new
        // refusal: it shows the message the server sent, which is the sentence.
        val fake = FakeFunctionsClient()
        val c = refusedPay(fake, IllegalStateException(PAID_INVOICE_REFUSAL))

        assertEquals(PAID_INVOICE_REFUSAL, c.payErrorFor("inv-1"))
        assertNull(c.error, "a refused Pay is not a list that failed to load")
        assertNull(c.paymentBeingRecorded)
        assertNull(c.checkingPayment)
    }
}
