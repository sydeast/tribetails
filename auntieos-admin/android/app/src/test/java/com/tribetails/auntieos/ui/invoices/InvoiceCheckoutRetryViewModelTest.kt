package com.tribetails.auntieos.ui.invoices
import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.contracts.RetryInvoiceCheckoutCloseResult
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
/**
 * "Try again" on the open-payment-links line (#1113). The line itself is read
 * off the invoice (see InvoiceCheckoutClosureTest); this pins the action.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InvoiceCheckoutRetryViewModelTest {
    private lateinit var viewModel: InvoiceDetailViewModel
    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
    @Before
    fun setup() {
        Dispatchers.setMain(StandardTestDispatcher())
        coEvery { invoiceRepository.getPayments() } returns Result.success(emptyList<Payment>())
        coEvery { invoiceRepository.getInvoiceLedger(any()) } returns Result.success(TestFixtures.emptyInvoiceLedger())
        coEvery { repository.getBusinessSettings() } returns Result.success(BusinessSettings())
        viewModel = InvoiceDetailViewModel(repository, invoiceRepository, mockk(relaxed = true))
    }
    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }
    private fun stuck() = Invoice(
        id = "i1", invoiceNumber = "1042", status = "paid", total = 40.0, amountDue = 0.0,
        checkoutSweep = mapOf("failed" to listOf(mapOf("sessionId" to "cs_b", "reason" to "Stripe is down."))),
    )
    private suspend fun TestScope.load(invoice: Invoice) {
        coEvery { invoiceRepository.getInvoiceById(invoice.id) } returns Result.success(invoice)
        viewModel.loadInvoice(invoice.id)
        advanceUntilIdle()
    }
    @Test
    fun `try again calls the callable, reloads the invoice, and says it worked`() = runTest {
        load(stuck())
        coEvery { invoiceRepository.retryInvoiceCheckoutClose("i1") } returns
            Result.success(RetryInvoiceCheckoutCloseResult(ok = true, invoiceId = "i1", closedCount = 1, failedCount = 0))
        viewModel.retryCheckoutClose()
        advanceUntilIdle()
        coVerify(exactly = 1) { invoiceRepository.retryInvoiceCheckoutClose("i1") }
        coVerify(atLeast = 2) { invoiceRepository.getInvoiceById("i1") }
        assertFalse(viewModel.uiState.value.retryingCheckout)
        assertEquals("Open payment links closed.", viewModel.uiState.value.toastMessage)
        assertFalse(viewModel.uiState.value.toastIsError)
    }
    @Test
    fun `a failure that persists is an error toast, not a success`() = runTest {
        load(stuck())
        coEvery { invoiceRepository.retryInvoiceCheckoutClose("i1") } returns
            Result.success(RetryInvoiceCheckoutCloseResult(ok = true, invoiceId = "i1", closedCount = 0, failedCount = 1))
        viewModel.retryCheckoutClose()
        advanceUntilIdle()
        assertTrue(viewModel.uiState.value.toastIsError)
        assertTrue(viewModel.uiState.value.toastMessage.contains("still could not be closed"))
        assertFalse(viewModel.uiState.value.retryingCheckout)
    }
    @Test
    fun `a refused call surfaces the server's words`() = runTest {
        load(stuck())
        coEvery { invoiceRepository.retryInvoiceCheckoutClose("i1") } returns
            Result.failure(IllegalStateException("Admin claim required."))
        viewModel.retryCheckoutClose()
        advanceUntilIdle()
        assertTrue(viewModel.uiState.value.toastIsError)
        assertTrue(viewModel.uiState.value.toastMessage.contains("Admin claim required."))
        assertFalse(viewModel.uiState.value.retryingCheckout)
    }
}
