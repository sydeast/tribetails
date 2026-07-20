package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Invoice
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class FakeAuntieDataSourceTest {

    @Test
    fun invoicesStream_startsLoading() = runTest {
        val ds = FakeAuntieDataSource()
        assertIs<FirestoreResult.Loading>(ds.invoicesStream().first())
    }

    @Test
    fun invoicesStream_emitsData() = runTest {
        val ds = FakeAuntieDataSource()
        val invoice = Invoice(_id = "inv1", invoiceNumber = "001", total = 100.0, amountDue = 100.0)
        ds.emitInvoices(FirestoreResult.Data(listOf(invoice)))

        val result = ds.invoicesStream().first()
        assertIs<FirestoreResult.Data<List<Invoice>>>(result)
        assertEquals(1, result.value.size)
        assertEquals("inv1", result.value.first()._id)
    }

    @Test
    fun invoicesStream_emitsError() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitInvoices(FirestoreResult.Error("network failure"))

        val result = ds.invoicesStream().first()
        assertIs<FirestoreResult.Error>(result)
        assertEquals("network failure", result.message)
    }
}
