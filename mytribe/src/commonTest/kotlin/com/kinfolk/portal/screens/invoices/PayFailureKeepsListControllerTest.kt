package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * #2442: A REFUSED OR FAILED PAY, OR A PDF THAT COULD NOT BE PREPARED, IS NOT A
 * LIST THAT FAILED TO LOAD.
 *
 * The controller used to keep one error for everything it did, and the list
 * drew "Couldn't load invoices" over the open invoices from it. A Pay refusal
 * now belongs to the invoice it was tapped on ([InvoicesController.payErrorFor]),
 * a PDF failure the same ([InvoicesController.pdfErrorFor]), and
 * [InvoicesController.error] means only that the invoices could not be read.
 * `PayFailureKeepsListTest` (composeUiTest) pins what the screens draw.
 */
class PayFailureKeepsListControllerTest {
    @BeforeTest
    fun noLinkWaiting() {
        PendingCheckoutReturn.clear()
    }

    @AfterTest
    fun leaveNoLinkWaiting() {
        PendingCheckoutReturn.clear()
    }

    private val refusal = "This invoice cannot take a payment right now. Please ask your Auntie to check it."

    private fun row(id: String, amountDue: Double): JsonObject = buildJsonObject {
        put("id", id)
        put("kinfolkId", "kin-1")
        put("total", amountDue)
        put("amountDue", amountDue)
        put("isPaid", false)
        put("status", "open")
    }

    private fun twoOpen(): JsonObject = buildJsonObject {
        put("accountBalanceCents", 0L)
        put("open", buildJsonArray {
            add(row("inv-1", 40.0))
            add(row("inv-2", 55.0))
        })
        put("paid", buildJsonArray {})
        put("credits", buildJsonArray {})
    }

    @Test
    fun `a refused Pay keeps the list and puts the server's sentence on that invoice alone`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", twoOpen())
        fake.stubError("payInvoice", IllegalStateException(refusal))
        val c = InvoicesController("kin-1", PortalApi(fake), this) { }
        c.reload()

        c.startPay(assertNotNull(c.find("inv-1")))
        advanceUntilIdle()

        assertNull(c.error, "the list loaded fine")
        assertEquals(2, assertNotNull(c.data).open.size)
        assertEquals(refusal, c.payErrorFor("inv-1"))
        assertNull(c.payErrorFor("inv-2"), "the sentence is about one invoice")
        assertNull(c.pdfErrorFor("inv-1"))
    }

    @Test
    fun `an offline Pay keeps the list too`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", twoOpen())
        fake.stubError("payInvoice", IllegalStateException("Could not reach the server. Check your connection."))
        val c = InvoicesController("kin-1", PortalApi(fake), this) { }
        c.reload()

        c.startPay(assertNotNull(c.find("inv-2")))
        advanceUntilIdle()

        assertNull(c.error)
        assertEquals("Could not reach the server. Check your connection.", c.payErrorFor("inv-2"))
    }

    @Test
    fun `a PDF that could not be prepared keeps the list and says so on that invoice`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", twoOpen())
        fake.stubError("getMyInvoicePdf", IllegalStateException("The PDF could not be made."))
        val c = InvoicesController("kin-1", PortalApi(fake), this) { }
        c.reload()

        c.startDownloadPdf(assertNotNull(c.find("inv-1")))
        advanceUntilIdle()

        assertNull(c.error)
        assertEquals("The PDF could not be made.", c.pdfErrorFor("inv-1"))
        assertNull(c.pdfErrorFor("inv-2"))
        assertNull(c.payErrorFor("inv-1"), "a PDF failure is not a Pay failure")
        assertNull(c.downloadingPdf)
    }

    @Test
    fun `a first read that fails is still a list that failed to load`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyInvoices", IllegalStateException("network down"))
        val c = InvoicesController("kin-1", PortalApi(fake), this) { }

        c.reload()

        assertEquals("network down", c.error)
        assertNull(c.data)
    }

    @Test
    fun `the next Pay tap and the next read of the list clear the sentence`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", twoOpen())
        fake.stubError("payInvoice", IllegalStateException(refusal))
        val c = InvoicesController("kin-1", PortalApi(fake), this) { }
        c.reload()
        c.startPay(assertNotNull(c.find("inv-1")))
        advanceUntilIdle()
        assertEquals(refusal, c.payErrorFor("inv-1"))

        // A tap on another invoice is a new attempt: the old sentence goes.
        fake.stub("payInvoice", buildJsonObject {
            put("checkoutUrl", "https://checkout.stripe.com/c/pay/cs_2")
            put("sessionId", "cs_2")
        })
        c.startPay(assertNotNull(c.find("inv-2")))
        advanceUntilIdle()
        assertNull(c.payErrorFor("inv-1"))
        assertNull(c.payErrorFor("inv-2"))

        // And a read of the list drops a sentence about the copy before it.
        fake.stubError("payInvoice", IllegalStateException(refusal))
        c.startPay(assertNotNull(c.find("inv-1")))
        advanceUntilIdle()
        assertEquals(refusal, c.payErrorFor("inv-1"))
        c.reload()
        assertNull(c.payErrorFor("inv-1"))
        assertNull(c.error)
    }
}
