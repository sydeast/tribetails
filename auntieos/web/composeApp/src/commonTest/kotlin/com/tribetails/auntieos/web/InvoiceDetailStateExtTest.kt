package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.screens.invoices.InvoiceDetailState
import com.tribetails.auntieos.web.screens.invoices.invoiceDetailStateFor
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

/**
 * Additional coverage for [invoiceDetailStateFor] beyond what InvoiceDetailTest covers.
 * Tests the "multiple invoices present but wrong id" edge case.
 */
class InvoiceDetailStateExtTest {

    @Test
    fun invoiceDetailStateFor_multipleInvoicesButWrongId_returnsNotFound() = runTest {
        val ds = FakeAuntieDataSource()
        // Emit a list containing TestData.invoices (3 invoices: inv-1, inv-2, inv-3)
        ds.emitInvoices(FirestoreResult.Data(TestData.invoices))

        val result = ds.invoicesStream().first()
        assertIs<FirestoreResult.Data<*>>(result)

        // Request an id that is not present in the list
        val state = invoiceDetailStateFor("inv-999", result)
        assertIs<InvoiceDetailState.NotFound>(state)
    }

    @Test
    fun invoiceDetailStateFor_firstInvoiceFoundWhenMultiplePresent() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitInvoices(FirestoreResult.Data(TestData.invoices))

        val result = ds.invoicesStream().first()
        assertIs<FirestoreResult.Data<*>>(result)

        val state = invoiceDetailStateFor(TestData.invoice1._id, result)
        assertIs<InvoiceDetailState.Loaded>(state)
    }

    @Test
    fun invoiceDetailStateFor_lastInvoiceFoundWhenMultiplePresent() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitInvoices(FirestoreResult.Data(TestData.invoices))

        val result = ds.invoicesStream().first()
        assertIs<FirestoreResult.Data<*>>(result)

        val state = invoiceDetailStateFor(TestData.invoice3._id, result)
        assertIs<InvoiceDetailState.Loaded>(state)
    }

    @Test
    fun invoiceDetailStateFor_emptyListReturnsNotFound() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitInvoices(FirestoreResult.Data(emptyList()))

        val result = ds.invoicesStream().first()
        val state = invoiceDetailStateFor("inv-1", result)
        assertIs<InvoiceDetailState.NotFound>(state)
    }

    // H4: empty string id should return NotFound, not crash

    @Test
    fun invoiceDetailStateFor_emptyStringId_returnsNotFound() {
        val state = invoiceDetailStateFor("", FirestoreResult.Data(listOf(TestData.invoice1)))
        assertIs<InvoiceDetailState.NotFound>(state)
    }

    // H9: duplicate IDs - must return first match deterministically, not crash

    @Test
    fun invoiceDetailStateFor_duplicateIds_returnsFirstMatch() {
        val inv1a = TestData.invoice1
        val inv1b = TestData.invoice1.copy(invoiceNumber = "INV-001-COPY", total = 999.0)
        val state = invoiceDetailStateFor("inv-1", FirestoreResult.Data(listOf(inv1a, inv1b)))
        assertIs<InvoiceDetailState.Loaded>(state)
        assertEquals(inv1a.invoiceNumber, state.invoice.invoiceNumber, "Must return the FIRST match")
    }
}
