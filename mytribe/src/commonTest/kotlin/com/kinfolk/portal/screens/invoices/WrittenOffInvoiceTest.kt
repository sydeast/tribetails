package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * #2090: the business wrote off what was left on an invoice. The household
 * reads it plainly on the Android app as on the web portal: Written off,
 * nothing to pay, no way to pay, and never "Paid" for money that did not come
 * in. Before this the decoder fell `written_off` through to Open, which would
 * have shown it as Pending with a Pay button.
 */
class WrittenOffInvoiceTest {

    private fun writtenOff(paidCents: Long = 2000L, writtenOffCents: Long? = 3000L): Invoice = Invoice(
        id = "inv-1",
        kinfolkId = "kin-1",
        kinfolkName = null,
        client = null,
        total = 50.0,
        amountDue = 0.0,
        isPaid = false,
        status = InvoiceStatus.WrittenOff,
        date = "2026-11-01",
        dueDate = "2026-11-10",
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
        writtenOffCents = writtenOffCents,
        paidCents = paidCents,
    )

    @Test
    fun decodesWrittenOffAsItsOwnStatusWithTheAmounts() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {})
            put("paid", buildJsonArray {
                add(buildJsonObject {
                    put("id", "wo-1")
                    put("kinfolkId", "kin-1")
                    put("total", 50.0)
                    put("amountDue", 0.0)
                    put("isPaid", false)
                    put("status", "written_off")
                    put("paidCents", 2000L)
                    put("writtenOffCents", 3000L)
                })
            })
            put("credits", buildJsonArray {})
        })
        val res = PortalApi(fake).getMyInvoices()
        val inv = res.paid.single()
        assertEquals(InvoiceStatus.WrittenOff, inv.status)
        assertEquals(3000L, inv.writtenOffCents)
        assertEquals(2000L, inv.paidCents)
    }

    @Test
    fun isNeverPayable() {
        assertFalse(isPayable(InvoiceStatus.WrittenOff))
        assertFalse(offersPayment(writtenOff()))
        // Not even with a stale positive balance on it.
        assertFalse(offersPayment(writtenOff().copy(amountDue = 9.0)))
    }

    @Test
    fun readsWrittenOffAndNothingToPay() {
        assertEquals("Written off", invoiceStatusLabel(InvoiceStatus.WrittenOff))
        assertEquals("WRITTEN OFF", invoiceStatusChipLabel(InvoiceStatus.WrittenOff))
        assertEquals("Amount Due" to "Nothing to pay", invoiceHeadline(writtenOff()))
        assertEquals("Written off, nothing to pay", paidRowMetaLabel(writtenOff()))
    }

    @Test
    fun aPaidInvoiceStillReadsPaid() {
        val paid = writtenOff().copy(status = InvoiceStatus.Paid, isPaid = true, writtenOffCents = null)
        assertEquals("Paid" to "\$50.00", invoiceHeadline(paid))
        assertEquals("Paid Nov 01, 2026", paidRowMetaLabel(paid))
    }
}
