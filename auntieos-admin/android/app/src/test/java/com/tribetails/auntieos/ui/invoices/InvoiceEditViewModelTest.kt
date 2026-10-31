package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.contracts.UpdateInvoiceArgsPatch
import com.tribetails.auntieos.data.contracts.UpdateInvoiceResult
import com.tribetails.auntieos.data.contracts.UpdateInvoiceResultTotals
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * #1174: the invoice editor on the detail ViewModel. Opening is gated by the
 * STORED editScope, the save goes through `updateInvoice` with only what the
 * form controls and the operator changed, and a refusal stays in the form.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InvoiceEditViewModelTest {

    private lateinit var viewModel: InvoiceDetailViewModel
    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
    private val testDispatcher = StandardTestDispatcher()

    private val ok = UpdateInvoiceResult(
        ok = true,
        invoiceId = "inv1",
        totals = UpdateInvoiceResultTotals(subtotalCents = 0, totalCents = 0, paidCents = 0, amountDueCents = 0),
    )

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        coEvery { invoiceRepository.getInvoiceLedger(any()) } returns Result.success(TestFixtures.emptyInvoiceLedger())
        coEvery { repository.getBusinessSettings() } returns Result.success(BusinessSettings())
        viewModel = InvoiceDetailViewModel(repository, invoiceRepository, mockk(relaxed = true))
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun invoice(scope: String?) = Invoice(
        id = "inv1",
        invoiceNumber = "1042",
        client = "Wanda Thorne",
        address = "12 Elm Row",
        date = "2026-10-01",
        dueDate = "2026-10-15",
        terms = "Net 14",
        total = 40.0,
        amountDue = 40.0,
        status = "open",
        editScope = scope,
    )

    private suspend fun TestScope.load(invoice: Invoice) {
        coEvery { invoiceRepository.getInvoiceById(invoice.id) } returns Result.success(invoice)
        viewModel.loadInvoice(invoice.id)
        advanceUntilIdle()
    }

    @Test
    fun `scope none opens nothing`() = runTest {
        load(invoice("none"))
        viewModel.openInvoiceEdit()
        assertNull(viewModel.uiState.value.invoiceEdit)
    }

    @Test
    fun `scope metadataOnly opens the form with money locked`() = runTest {
        load(invoice("metadataOnly"))
        viewModel.openInvoiceEdit()
        val draft = viewModel.uiState.value.invoiceEdit
        assertNotNull(draft)
        assertFalse(draft!!.moneyEditable)
    }

    @Test
    fun `save sends only the changed field through updateInvoice, then closes and reloads`() = runTest {
        load(invoice("all"))
        val sent = slot<UpdateInvoiceArgsPatch>()
        coEvery { invoiceRepository.updateInvoice("inv1", capture(sent)) } returns Result.success(ok)

        viewModel.openInvoiceEdit()
        viewModel.updateInvoiceEdit(viewModel.uiState.value.invoiceEdit!!.copy(dueDate = "2026-10-30"))
        viewModel.saveInvoiceEdit()
        advanceUntilIdle()

        // An un-itemized invoice: no lineItems key, and nothing the form does
        // not control (client, address) on the wire.
        assertEquals(mapOf("dueDate" to "2026-10-30"), sent.captured.toPayload())
        assertNull(viewModel.uiState.value.invoiceEdit)
        assertEquals("Invoice updated.", viewModel.uiState.value.toastMessage)
        // Reloaded twice over: the initial load, then the quiet reload after the save.
        coVerify(exactly = 2) { invoiceRepository.getInvoiceById("inv1") }
        coVerify(exactly = 2) { invoiceRepository.getInvoiceLedger("inv1") }
    }

    @Test
    fun `a refusal stays in the form verbatim, with what was typed`() = runTest {
        load(invoice("all"))
        coEvery { invoiceRepository.updateInvoice(any(), any()) } returns
            Result.failure(RuntimeException("This invoice has a recorded payment, so its money is locked."))

        viewModel.openInvoiceEdit()
        viewModel.updateInvoiceEdit(viewModel.uiState.value.invoiceEdit!!.copy(terms = "Net 30"))
        viewModel.saveInvoiceEdit()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals("Net 30", state.invoiceEdit?.terms)
        assertEquals(
            "updateInvoice failed: This invoice has a recorded payment, so its money is locked.",
            state.invoiceEditError,
        )
        assertFalse(state.savingInvoiceEdit)
    }

    @Test
    fun `nothing changed never reaches the callable`() = runTest {
        load(invoice("all"))
        viewModel.openInvoiceEdit()
        viewModel.saveInvoiceEdit()
        advanceUntilIdle()
        assertEquals("Nothing has changed yet.", viewModel.uiState.value.invoiceEditError)
        coVerify(exactly = 0) { invoiceRepository.updateInvoice(any(), any()) }
    }
}
