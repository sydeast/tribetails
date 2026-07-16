package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.repository.AuntieRepository
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

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        // Default stub: session fetch returns empty list so tests that only care
        // about invoice loading don't break on the new getKinCareSessionsForKinfolk call.
        coEvery { mockRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        // loadInvoice now also loads payments for the per-invoice join (spec 17).
        coEvery { mockRepo.getPayments() } returns Result.success(emptyList<com.tribetails.auntieos.data.model.Payment>())
        // A8: loadInvoice also fetches business settings for the "How to pay" section.
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(com.tribetails.auntieos.data.model.BusinessSettings())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = InvoiceDetailViewModel(repository = mockRepo)

    @Test
    fun `initial state has no invoice and no error`() {
        val vm = buildViewModel()
        val state = vm.uiState.value
        assertNull(state.invoice)
        assertNull(state.error)
    }

    @Test
    fun `loadInvoice populates invoice on success`() = runTest(testDispatcher) {
        coEvery { mockRepo.getInvoiceById("inv1") } returns Result.success(TestFixtures.invoice1)

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
        coEvery { mockRepo.getInvoiceById(any()) } returns Result.failure(RuntimeException("Not found"))

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
        coEvery { mockRepo.getInvoiceById("inv1") } returnsMany listOf(
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
        coVerify(exactly = 2) { mockRepo.getInvoiceById("inv1") }
    }

    @Test
    fun `loadInvoice with empty string id sets error state`() = runTest(testDispatcher) {
        coEvery { mockRepo.getInvoiceById("") } returns
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
