package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Slice 2 integration: FirestoreClient.createInvoice / generateReceipt route
 * through platformInvokeCallable, which the jvm actual answers from
 * JvmFirestoreFixtures.callableResponses. Covers happy, decode-failure, and the
 * stubbed-error (sad) path. This also covers desktop (same jvm actual).
 */
class CreateInvoiceClientTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.callableResponses = emptyMap()
    }

    private fun invoice() = Invoice(
        kinfolkId = "kf1",
        kinfolkName = "Halbrook Household",
        invoiceNumber = "INV-9",
        total = 120.0,
        amountDue = 120.0,
        status = "sent",
    )

    @Test
    fun createInvoiceReturnsServerMintedId() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createInvoice" to """{"ok":true,"invoiceId":"inv_1"}""")
        val r = FirestoreClient().createInvoice(invoice())
        assertTrue(r is WriteResult.Ok)
        assertEquals("inv_1", (r as WriteResult.Ok).value)
    }

    @Test
    fun createInvoiceMissingIdDecodesToBlankNotCrash() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createInvoice" to """{"ok":true}""")
        val r = FirestoreClient().createInvoice(invoice())
        assertTrue(r is WriteResult.Ok)
        assertEquals("", (r as WriteResult.Ok).value)
    }

    @Test
    fun createInvoiceMalformedJsonSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createInvoice" to "not-json{")
        val r = FirestoreClient().createInvoice(invoice())
        assertTrue(r is WriteResult.Err)
    }

    @Test
    fun generateReceiptHappyPathOk() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("generateReceipt" to """{"ok":true}""")
        val r = FirestoreClient().generateReceipt("inv_1")
        assertTrue(r is WriteResult.Ok)
    }
}
