package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.data.repository.AuntieRepository
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
 * Task 5.1 archive and restore on Android.
 *
 * Archive was NOT deferred to 5.1a with the line-item editor, because an invoice
 * archived on the web would otherwise still be counted into Android's revenue
 * tiles. That is a correctness bug, not a parity nicety.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InvoiceArchiveViewModelTest {

    private lateinit var viewModel: InvoiceDetailViewModel
    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        coEvery { repository.getPayments() } returns Result.success(emptyList<Payment>())
        coEvery { repository.getBusinessSettings() } returns Result.success(BusinessSettings())
        viewModel = InvoiceDetailViewModel(repository)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private suspend fun TestScope.loadInvoice(invoice: Invoice) {
        coEvery { repository.getInvoiceById(invoice.id) } returns Result.success(invoice)
        viewModel.loadInvoice(invoice.id)
        advanceUntilIdle()
    }

    private fun openInvoice() = Invoice(id = "i1", invoiceNumber = "1042", total = 40.0, amountDue = 40.0)

    private fun archivedInvoice() = openInvoice().apply { archivedAt = "2026-07-25T00:00:00Z" }

    @Test
    fun `prompting does not send anything on its own`() = runTest {
        loadInvoice(openInvoice())
        viewModel.promptArchive()
        advanceUntilIdle()
        assertTrue(viewModel.uiState.value.archivePrompt)
        coVerify(exactly = 0) { repository.archiveInvoice(any(), any()) }
    }

    @Test
    fun `confirming archives without force`() = runTest {
        loadInvoice(openInvoice())
        coEvery { repository.archiveInvoice("i1", false) } returns Result.success(Unit)
        viewModel.promptArchive()
        viewModel.confirmArchive(false)
        advanceUntilIdle()
        coVerify { repository.archiveInvoice("i1", false) }
        assertFalse(viewModel.uiState.value.archivePrompt)
        assertEquals("Invoice archived.", viewModel.uiState.value.toastMessage)
    }

    @Test
    fun `a still-owing refusal RE-OFFERS the choice as an explicit write-off`() = runTest {
        // The server refuses rather than silently dropping a real balance out of
        // the outstanding total. That is a decision to hand back to the operator,
        // not an error to bounce off, so the confirm stays open.
        loadInvoice(openInvoice())
        coEvery { repository.archiveInvoice("i1", false) } returns
            Result.failure(RuntimeException("This invoice still has \$40.00 owing. Archiving it would drop that from the outstanding total."))
        viewModel.promptArchive()
        viewModel.confirmArchive(false)
        advanceUntilIdle()
        assertTrue(viewModel.uiState.value.archivePrompt)
        assertTrue(viewModel.uiState.value.archiveForceOffered)
        assertTrue(viewModel.uiState.value.toastIsError)
    }

    @Test
    fun `forcing takes a SECOND explicit press and says what was given up`() = runTest {
        loadInvoice(openInvoice())
        coEvery { repository.archiveInvoice("i1", true) } returns Result.success(Unit)
        viewModel.promptArchive()
        viewModel.confirmArchive(true)
        advanceUntilIdle()
        coVerify { repository.archiveInvoice("i1", true) }
        assertTrue(viewModel.uiState.value.toastMessage.contains("written off"))
    }

    @Test
    fun `any other failure closes the prompt and reports verbatim`() = runTest {
        loadInvoice(openInvoice())
        coEvery { repository.archiveInvoice("i1", false) } returns
            Result.failure(RuntimeException("This invoice is already archived."))
        viewModel.promptArchive()
        viewModel.confirmArchive(false)
        advanceUntilIdle()
        assertFalse(viewModel.uiState.value.archivePrompt)
        assertTrue(viewModel.uiState.value.toastMessage.contains("already archived"))
    }

    @Test
    fun `an ARCHIVED invoice restores instead of archiving`() = runTest {
        loadInvoice(archivedInvoice())
        coEvery { repository.unarchiveInvoice("i1") } returns Result.success(Unit)
        viewModel.promptArchive()
        viewModel.confirmArchive(false)
        advanceUntilIdle()
        coVerify { repository.unarchiveInvoice("i1") }
        coVerify(exactly = 0) { repository.archiveInvoice(any(), any()) }
        assertTrue(viewModel.uiState.value.toastMessage.contains("restored"))
    }

    @Test
    fun `dismissing while a call is in flight does not close the prompt`() = runTest {
        loadInvoice(openInvoice())
        // Stubbed even though this test never advances to it: `runTest` drains
        // the scheduler on the way out, and a relaxed mockk hands back a bare
        // Object that cannot be cast to the Result the coroutine awaits.
        coEvery { repository.archiveInvoice("i1", false) } returns Result.success(Unit)
        viewModel.promptArchive()
        viewModel.confirmArchive(false)
        // Still in flight: the dispatcher has not been advanced.
        viewModel.dismissArchivePrompt()
        assertTrue(viewModel.uiState.value.archivePrompt)
    }
}

/** The two pure helpers beside the ViewModel. */
class InvoiceArchiveHelpersTest {

    @Test
    fun `recognises the server's still-owing refusal`() {
        assertTrue(
            archiveRefusedForMoneyOwed("This invoice still has \$40.00 owing. Archiving it would drop that from the outstanding total."),
        )
    }

    @Test
    fun `does not treat an already-archived refusal as a money question`() {
        assertFalse(archiveRefusedForMoneyOwed("This invoice is already archived."))
        assertFalse(archiveRefusedForMoneyOwed("Sign in required."))
        assertFalse(archiveRefusedForMoneyOwed(""))
    }

    @Test
    fun `a forced archive says what was actually given up`() {
        assertEquals("Invoice archived.", archiveSuccessMessage(restoring = false, force = false))
        assertTrue(archiveSuccessMessage(restoring = false, force = true).contains("written off"))
        assertTrue(archiveSuccessMessage(restoring = true, force = false).contains("restored"))
    }
}
