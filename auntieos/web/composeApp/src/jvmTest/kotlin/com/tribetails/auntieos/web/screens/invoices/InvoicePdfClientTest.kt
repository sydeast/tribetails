package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Stage 3 / 16.2: FirestoreClient.generateInvoicePdf routes through
 * platformInvokeCallable, answered on jvm (= desktop) by JvmFirestoreFixtures.
 */
class InvoicePdfClientTest {

    @AfterTest
    fun tearDown() { JvmFirestoreFixtures.callableResponses = emptyMap() }

    @Test
    fun happyPath_returnsUrl() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "generateInvoicePdf" to """{"ok":true,"invoiceId":"i1","pdfUrl":"https://firebasestorage.googleapis.com/v0/b/demo/o/invoice_pdfs%2Fi1%2Ftok.pdf?alt=media&token=tok"}""",
        )
        val r = FirestoreClient().generateInvoicePdf("i1")
        assertTrue(r is WriteResult.Ok)
        assertTrue((r as WriteResult.Ok).value.startsWith("https://firebasestorage.googleapis.com"))
    }

    @Test
    fun blankUrl_surfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("generateInvoicePdf" to """{"ok":true,"invoiceId":"i1"}""")
        val r = FirestoreClient().generateInvoicePdf("i1")
        assertTrue(r is WriteResult.Err)
    }

    @Test
    fun malformedJson_surfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("generateInvoicePdf" to "not-json{")
        val r = FirestoreClient().generateInvoicePdf("i1")
        assertTrue(r is WriteResult.Err)
    }
}
