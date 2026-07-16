package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Stage 3 / 16.2 - kinfolk getMyInvoicePdf PortalApi wiring. */
class InvoicePdfPortalApiTest {

    @Test
    fun getMyInvoicePdf_returnsUrl_andSendsInvoiceId() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoicePdf", buildJsonObject {
            put("ok", true); put("invoiceId", "i1")
            put("pdfUrl", "https://firebasestorage.googleapis.com/v0/b/demo/o/invoice_pdfs%2Fi1%2Ftok.pdf?alt=media&token=tok")
        })
        val api = PortalApi(fake)
        val url = api.getMyInvoicePdf("i1", "kf1")
        assertTrue(url.startsWith("https://firebasestorage.googleapis.com"))
        assertEquals("getMyInvoicePdf", fake.calls[0].first)
        val payload = fake.calls[0].second!!
        assertEquals("i1", payload["invoiceId"].toString().trim('"'))
        assertEquals("kf1", payload["kinfolkId"].toString().trim('"'))
    }

    @Test
    fun getMyInvoicePdf_omitsKinfolkId_whenNull() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoicePdf", buildJsonObject { put("pdfUrl", "https://x/y") })
        val api = PortalApi(fake)
        api.getMyInvoicePdf("i1")
        assertTrue(!fake.calls[0].second!!.containsKey("kinfolkId"))
    }

    @Test
    fun getMyInvoicePdf_throws_whenUrlMissing() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoicePdf", buildJsonObject { put("ok", true) })
        val api = PortalApi(fake)
        assertFailsWith<IllegalStateException> { api.getMyInvoicePdf("i1", "kf1") }
    }
}
