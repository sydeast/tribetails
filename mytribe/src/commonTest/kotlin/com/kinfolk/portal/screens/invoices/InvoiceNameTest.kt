package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * ISSUE #1848: the portal printed an invoice's stored id after the "#"
 * ("Invoice #inv_1731000000000_ab12cd"), a string no Kinfolk can quote to the
 * office. `invoiceName` is the one function every invoice row, the credit row
 * and the invoice screen's title read, so the cases are pinned once here. The
 * id is of the shape the server mints, and no name may carry it.
 */
class InvoiceNameTest {

    private val storedId = "inv_1731000000000_ab12cd"

    private fun invoice(number: String?, status: InvoiceStatus = InvoiceStatus.Open): Invoice = Invoice(
        id = storedId,
        kinfolkId = "kin-1",
        kinfolkName = null,
        client = null,
        total = 40.0,
        amountDue = 40.0,
        isPaid = false,
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
        invoiceNumber = number,
    )

    @Test
    fun `an invoice is named by its number`() {
        assertEquals("Invoice #1042", invoiceName(invoice("1042")))
        assertEquals("Invoice #INV-2027-0001", invoiceName(invoice(" INV-2027-0001 ")))
        assertEquals("Invoice #1042", invoiceName(invoice("1042", InvoiceStatus.Paid)))
        assertEquals("Invoice #1042", invoiceName(invoice("1042", InvoiceStatus.Credit)))
    }

    @Test
    fun `a quote is named as a quote`() {
        assertEquals("Quote #Q-7", invoiceName(invoice("Q-7", InvoiceStatus.Quote)))
        assertEquals("Quote with no number", invoiceName(invoice(null, InvoiceStatus.Quote)))
    }

    @Test
    fun `an invoice with no number says so in words and never shows its id`() {
        for (none in listOf(null, "", "   ")) {
            val name = invoiceName(invoice(none))
            assertEquals("Invoice with no number", name)
            assertFalse(name.contains(storedId))
        }
    }

    private suspend fun decodedNumber(put: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): String? {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {
                add(buildJsonObject {
                    put("id", storedId)
                    put("kinfolkId", "3")
                    put("total", 50.0)
                    put("amountDue", 50.0)
                    put("isPaid", false)
                    put("status", "open")
                    put()
                })
            })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
        return PortalApi(fake).getMyInvoices("3").open[0].invoiceNumber
    }

    @Test
    fun `the number is read off the server's answer`() = runTest {
        assertEquals("1042", decodedNumber { put("invoiceNumber", " 1042 ") })
    }

    @Test
    fun `no number, a blank one and a server older than the field all decode to none`() = runTest {
        assertEquals(null, decodedNumber { put("invoiceNumber", JsonNull) })
        assertEquals(null, decodedNumber { put("invoiceNumber", "  ") })
        assertEquals(null, decodedNumber { })
    }
}
