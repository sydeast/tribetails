package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.screens.invoices.InvoiceDetailState
import com.tribetails.auntieos.web.screens.invoices.invoiceDetailStateFor
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

class InvoiceDetailTest {

    private val sampleInvoice = Invoice(
        _id           = "inv-42",
        invoiceNumber = "INV-042",
        kinfolkName   = "Rosie Threadgill",
        client        = "Threadgill Household",
        total         = 375.00,
        amountDue     = 375.00,
        dueDate       = "2026-07-15",
        status        = "outstanding",
    )

    @Test
    fun invoiceDetailStateFor_returnsCorrectInvoiceFromDataResult() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitInvoices(FirestoreResult.Data(listOf(sampleInvoice)))

        val result = ds.invoicesStream().first()
        assertIs<FirestoreResult.Data<List<Invoice>>>(result)

        val detailState = invoiceDetailStateFor("inv-42", result)
        assertIs<InvoiceDetailState.Loaded>(detailState)
        assertEquals("inv-42", detailState.invoice._id)
        assertEquals("Rosie Threadgill", detailState.invoice.kinfolkName)
    }

    @Test
    fun invoiceDetailStateFor_returnsNotFoundWhenIdMissing() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitInvoices(FirestoreResult.Data(listOf(sampleInvoice)))

        val result = ds.invoicesStream().first()
        assertIs<FirestoreResult.Data<List<Invoice>>>(result)

        val detailState = invoiceDetailStateFor("no-such-id", result)
        assertIs<InvoiceDetailState.NotFound>(detailState)
    }

    @Test
    fun invoiceDetailStateFor_returnsErrorOnFirestoreError() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitInvoices(FirestoreResult.Error("connection refused"))

        val result = ds.invoicesStream().first()
        assertIs<FirestoreResult.Error>(result)

        val detailState = invoiceDetailStateFor("any-id", result)
        assertIs<InvoiceDetailState.Err>(detailState)
        assertEquals("connection refused", detailState.message)
    }

    @Test
    fun invoiceDetailStateFor_returnsLoadingWhenResultIsLoading() = runTest {
        val ds = FakeAuntieDataSource()
        // default initial state is Loading
        val result = ds.invoicesStream().first()
        assertIs<FirestoreResult.Loading>(result)

        val detailState = invoiceDetailStateFor("any-id", result)
        assertIs<InvoiceDetailState.Loading>(detailState)
    }

    @Test
    fun loaded_invoiceHasCorrectFinancials() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitInvoices(FirestoreResult.Data(listOf(sampleInvoice)))

        val result = ds.invoicesStream().first()
        val detailState = invoiceDetailStateFor("inv-42", result)
        assertIs<InvoiceDetailState.Loaded>(detailState)

        assertEquals(375.00, detailState.invoice.total)
        assertEquals(375.00, detailState.invoice.amountDue)
        assertEquals("2026-07-15", detailState.invoice.dueDate)
    }
}
