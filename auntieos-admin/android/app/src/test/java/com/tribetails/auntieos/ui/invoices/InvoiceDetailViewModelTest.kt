package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class InvoiceDetailViewModelTest {

    private lateinit var viewModel: InvoiceDetailViewModel
    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        // loadInvoice now also loads payments for the per-invoice join.
        coEvery { invoiceRepository.getPayments() } returns Result.success(emptyList<com.tribetails.auntieos.data.model.Payment>())
        // The detail screen loads its payment lists from getInvoiceLedger now,
        // not from the raw root-collection read. A relaxed mockk cannot stand in:
        // Result<T> erases, so its default is a bare Object and the first read
        // throws. These cases are not about payments; an empty ledger is enough.
        coEvery { invoiceRepository.getInvoiceLedger(any()) } returns Result.success(TestFixtures.emptyInvoiceLedger())
        // A8: loadInvoice also fetches business settings for the "How to pay" section.
        coEvery { repository.getBusinessSettings() } returns Result.success(com.tribetails.auntieos.data.model.BusinessSettings())
        viewModel = InvoiceDetailViewModel(repository, invoiceRepository, mockk(relaxed = true))
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `loadInvoice populates state with invoice on success`() = runTest {
        val invoice = Invoice(
            id = "inv123",
            invoiceNumber = "INV-001",
            kinfolkName = "Mable Johnson",
            total = 250.0,
            amountDue = 0.0,
            status = "paid",
            dueDate = "2026-06-01"
        )
        coEvery { invoiceRepository.getInvoiceById("inv123") } returns Result.success(invoice)

        viewModel.loadInvoice("inv123")
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.isLoading)
        assertNull(state.error)
        assertNotNull(state.invoice)
        assertEquals("inv123", state.invoice!!.id)
        assertEquals("Mable Johnson", state.invoice!!.kinfolkName)
    }

    @Test
    fun `loadInvoice sets error when invoice not found`() = runTest {
        coEvery { invoiceRepository.getInvoiceById("missing") } returns Result.failure(
            NoSuchElementException("Invoice not found")
        )

        viewModel.loadInvoice("missing")
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.isLoading)
        assertNull(state.invoice)
        assertNotNull(state.error)
        assertTrue(state.error!!.isNotBlank())
    }

    @Test
    fun `loadInvoice sets isLoading then clears it`() = runTest {
        val invoice = Invoice(id = "inv999", invoiceNumber = "INV-999")
        coEvery { invoiceRepository.getInvoiceById("inv999") } returns Result.success(invoice)

        viewModel.loadInvoice("inv999")
        // isLoading should be true before coroutine runs
        assertTrue(viewModel.uiState.value.isLoading)

        advanceUntilIdle()

        assertFalse(viewModel.uiState.value.isLoading)
    }

    // ── Stage 3 / 16.2: invoice PDF download ─────────────────────────────────
    private fun loadInvoiceFor(id: String) {
        coEvery { invoiceRepository.getInvoiceById(id) } returns Result.success(Invoice(id = id, invoiceNumber = "INV-$id"))
        viewModel.loadInvoice(id)
    }

    @Test
    fun `downloadPdf success sets pdfUrlToOpen and consume clears it`() = runTest {
        loadInvoiceFor("inv-pdf")
        advanceUntilIdle()
        coEvery { invoiceRepository.generateInvoicePdf("inv-pdf") } returns Result.success("https://firebasestorage.example/x?token=t")

        viewModel.downloadPdf()
        advanceUntilIdle()

        val s = viewModel.uiState.value
        assertEquals("https://firebasestorage.example/x?token=t", s.pdfUrlToOpen)
        assertFalse(s.generatingPdf)
        assertFalse(s.toastIsError)

        viewModel.consumePdfUrl()
        assertNull(viewModel.uiState.value.pdfUrlToOpen)
    }

    @Test
    fun `downloadPdf failure surfaces fail-loud toast and no url`() = runTest {
        loadInvoiceFor("inv-bad")
        advanceUntilIdle()
        coEvery { invoiceRepository.generateInvoicePdf("inv-bad") } returns Result.failure(RuntimeException("boom"))

        viewModel.downloadPdf()
        advanceUntilIdle()

        val s = viewModel.uiState.value
        assertNull(s.pdfUrlToOpen)
        assertFalse(s.generatingPdf)
        assertTrue(s.toastIsError)
    }
}
