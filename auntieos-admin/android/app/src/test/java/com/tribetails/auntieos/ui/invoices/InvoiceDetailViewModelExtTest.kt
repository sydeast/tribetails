package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class InvoiceDetailViewModelExtTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private lateinit var mockInvoiceRepo: InvoiceRepository
    private lateinit var mockKinCareRepo: KinCareRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        mockInvoiceRepo = mockk()
        mockKinCareRepo = mockk()
        // Default stub: session fetch returns empty list so tests that only care
        // about invoice loading don't break on the new getKinCareSessionsForKinfolk call.
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        // loadInvoice now also loads payments for the per-invoice join (spec 17).
        coEvery { mockInvoiceRepo.getPayments() } returns Result.success(emptyList<com.tribetails.auntieos.data.model.Payment>())
        // The detail screen loads its payment lists from getInvoiceLedger now,
        // not from the raw root-collection read. A relaxed mockk cannot stand in:
        // Result<T> erases, so its default is a bare Object and the first read
        // throws. These cases are not about payments; an empty ledger is enough.
        coEvery { mockInvoiceRepo.getInvoiceLedger(any()) } returns Result.success(TestFixtures.emptyInvoiceLedger())
        // A8: loadInvoice also fetches business settings for the "How to pay" section.
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(com.tribetails.auntieos.data.model.BusinessSettings())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = InvoiceDetailViewModel(repository = mockRepo, invoiceRepository = mockInvoiceRepo, kinCareRepository = mockKinCareRepo)

    @Test
    fun `initial state has no invoice and no error`() {
        val vm = buildViewModel()
        val state = vm.uiState.value
        assertNull(state.invoice)
        assertNull(state.error)
    }

    @Test
    fun `loadInvoice populates invoice on success`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(TestFixtures.invoice1)

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertNotNull(state.invoice)
        assertEquals("inv1", state.invoice!!.id)
        assertNull(state.error)
    }

    @Test
    fun `loadInvoice sets error on repository failure`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById(any()) } returns Result.failure(RuntimeException("Not found"))

        val vm = buildViewModel()
        vm.loadInvoice("inv99")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertNull(state.invoice)
        assertNotNull(state.error)
        assertNotNull(state.error!!.isNotBlank())
    }

    @Test
    fun `retry after error calls loadInvoice again`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returnsMany listOf(
            Result.failure(RuntimeException("Timeout")),
            Result.success(TestFixtures.invoice1)
        )

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)

        vm.loadInvoice("inv1")
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.invoice)
        assertNull(vm.uiState.value.error)
        coVerify(exactly = 2) { mockInvoiceRepo.getInvoiceById("inv1") }
    }

    @Test
    fun `loadInvoice with empty string id sets error state`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("") } returns
            Result.failure(RuntimeException("Document path must not be empty"))

        val vm = buildViewModel()
        vm.loadInvoice("")
        advanceUntilIdle()

        assertNotNull(
            "Expected error when loadInvoice called with empty id",
            vm.uiState.value.error
        )
        assertNull(vm.uiState.value.invoice)
    }
}
