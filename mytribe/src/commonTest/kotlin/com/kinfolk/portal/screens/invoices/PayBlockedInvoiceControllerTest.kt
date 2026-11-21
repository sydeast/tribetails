package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PayMethod
import com.kinfolk.portal.portal.PayMethodKind
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2410: AN OPEN BILL THE SERVER SAYS CANNOT TAKE A PAYMENT OFFERS NO PAY.
 *
 * `getMyInvoices` asks `payInvoice`'s own rule for each invoice the screens
 * would otherwise offer Pay on (it states a balance while nothing is owed on
 * its total) and ships the answer as `payBlockedReason`. A card payment on
 * such an invoice is kept off it for the owner to decide on, so this app must
 * not start one. These pin the decode, the one pay rule and the controller;
 * `PayBlockedInvoiceTest` (composeUiTest) pins what the screens draw.
 */
class PayBlockedInvoiceControllerTest {

    private val sentence = "This invoice cannot take a payment right now. Please ask your Auntie to check it."

    private fun invoice(
        status: InvoiceStatus = InvoiceStatus.Open,
        isPaid: Boolean = false,
        amountDue: Double = 100.0,
        payBlockedReason: String? = sentence,
    ): Invoice = Invoice(
        id = "inv-1",
        kinfolkId = "kin-1",
        kinfolkName = null,
        client = null,
        total = 0.0,
        amountDue = amountDue,
        isPaid = isPaid,
        status = status,
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
        payMethods = emptyList(),
        payBlockedReason = payBlockedReason,
    )

    /** [sendsKey] false is a server older than the field: no `payBlockedReason` key at all. */
    private fun invoiceJson(id: String, reason: String?, sendsKey: Boolean = true): JsonObject = buildJsonObject {
        put("id", id)
        put("kinfolkId", "kin-1")
        put("amountDue", 100.0)
        put("total", 0.0)
        put("isPaid", false)
        put("status", "open")
        put("payMethods", buildJsonArray {})
        if (sendsKey) {
            if (reason == null) put("payBlockedReason", JsonNull) else put("payBlockedReason", reason)
        }
    }

    @Test
    fun `the reason is decoded, and a null, a blank and an absent one all read as not blocked`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {
                add(invoiceJson("blocked", sentence))
                add(invoiceJson("null-reason", null))
                add(invoiceJson("blank-reason", "  "))
                add(invoiceJson("older-server", null, sendsKey = false))
            })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })

        val open = PortalApi(fake).getMyInvoices("kin-1").open.associateBy { it.id }

        assertEquals(sentence, open.getValue("blocked").payBlockedReason)
        assertFalse(offersPayment(open.getValue("blocked")))
        for (id in listOf("null-reason", "blank-reason", "older-server")) {
            assertNull(open.getValue(id).payBlockedReason, id)
            assertTrue(offersPayment(open.getValue(id)), id)
            assertNull(payBlockedReason(open.getValue(id)), id)
        }
    }

    @Test
    fun `the pay rule refuses a blocked bill and gives its sentence only for a bill waiting to be paid`() {
        assertFalse(offersPayment(invoice()))
        assertEquals(sentence, payBlockedReason(invoice()))
        // Not blocked: payable, and nothing to say.
        assertTrue(offersPayment(invoice(payBlockedReason = null)))
        assertNull(payBlockedReason(invoice(payBlockedReason = null)))
        // A quote, a credit and a paid invoice already say what they are.
        assertNull(payBlockedReason(invoice(status = InvoiceStatus.Quote)))
        assertNull(payBlockedReason(invoice(status = InvoiceStatus.Credit)))
        assertNull(payBlockedReason(invoice(isPaid = true)))
        assertNull(payBlockedReason(invoice(amountDue = 0.0)))
    }

    @Test
    fun `a tap on a blocked bill starts no checkout and shows the server's sentence`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("payInvoice", buildJsonObject {
            put("checkoutUrl", "https://checkout.stripe.com/c/pay/cs_1")
            put("sessionId", "cs_1")
        })
        val opened = mutableListOf<String>()
        val c = InvoicesController("kin-1", PortalApi(fake), this) { opened += it }

        c.startPay(invoice())
        advanceUntilIdle()

        assertTrue(fake.calls.none { it.first == "payInvoice" }, "payInvoice was called: ${fake.calls.map { it.first }}")
        assertTrue(opened.isEmpty(), "a page was opened: $opened")
        assertEquals(sentence, c.error)
    }

    @Test
    fun `a pay link on a blocked bill opens nothing either`() = runTest {
        val fake = FakeFunctionsClient()
        val opened = mutableListOf<String>()
        val c = InvoicesController("kin-1", PortalApi(fake), this) { opened += it }

        c.startPayMethod(invoice(), PayMethod("venmo", "Pay with Venmo", PayMethodKind.Link, "https://venmo.com/u/auntie"))
        c.startPayMethod(invoice(), PayMethod("stripe", "Pay with Credit Card", PayMethodKind.Checkout, null))
        advanceUntilIdle()

        assertTrue(opened.isEmpty(), "a page was opened: $opened")
        assertTrue(fake.calls.none { it.first == "payInvoice" })
        assertEquals(sentence, c.error)
    }

    @Test
    fun `an ordinary open bill still reaches the checkout`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("payInvoice", buildJsonObject {
            put("checkoutUrl", "https://checkout.stripe.com/c/pay/cs_1")
            put("sessionId", "cs_1")
        })
        val opened = mutableListOf<String>()
        val c = InvoicesController("kin-1", PortalApi(fake), this) { opened += it }

        c.startPay(invoice(payBlockedReason = null))
        advanceUntilIdle()

        assertEquals(listOf("https://checkout.stripe.com/c/pay/cs_1"), opened)
        assertNull(c.error)
    }
}
