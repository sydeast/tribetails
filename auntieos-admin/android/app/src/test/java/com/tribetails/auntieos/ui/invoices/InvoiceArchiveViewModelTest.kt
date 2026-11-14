package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.TestFixtures
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import com.tribetails.auntieos.domain.InvoiceAction
import com.tribetails.auntieos.domain.InvoiceState
import com.tribetails.auntieos.domain.cannotArchiveOwedText
import com.tribetails.auntieos.domain.invoiceActionsFor
import com.tribetails.auntieos.domain.invoiceActionsOffered
import com.tribetails.auntieos.domain.invoiceStateOrNull
import com.tribetails.auntieos.domain.invoiceWriteOffOwedCents
import com.tribetails.auntieos.domain.writeOffConfirmText
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
    private val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        coEvery { invoiceRepository.getPayments() } returns Result.success(emptyList<Payment>())
        // The detail screen loads its payment lists from getInvoiceLedger now,
        // not from the raw root-collection read. A relaxed mockk cannot stand in:
        // Result<T> erases, so its default is a bare Object and the first read
        // throws. These cases are not about payments; an empty ledger is enough.
        coEvery { invoiceRepository.getInvoiceLedger(any()) } returns Result.success(TestFixtures.emptyInvoiceLedger())
        coEvery { repository.getBusinessSettings() } returns Result.success(BusinessSettings())
        viewModel = InvoiceDetailViewModel(repository, invoiceRepository, mockk(relaxed = true))
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private suspend fun TestScope.loadInvoice(invoice: Invoice) {
        coEvery { invoiceRepository.getInvoiceById(invoice.id) } returns Result.success(invoice)
        viewModel.loadInvoice(invoice.id)
        advanceUntilIdle()
    }

    /** A sent invoice with $40.00 owed. */
    private fun openInvoice() =
        Invoice(id = "i1", invoiceNumber = "1042", kinfolkName = "The Whitfields", total = 40.0, amountDue = 40.0)
            .apply { status = "open"; amountDueCents = 4000L }
    /** Settled: nothing owed, so archiving is plain tidying (#2090). */
    private fun paidInvoice() = openInvoice().apply { status = "paid"; amountDue = 0.0; amountDueCents = 0L }
    private fun archivedInvoice() = paidInvoice().apply { archivedAt = "2026-07-25T00:00:00Z" }
    @Test
    fun `prompting does not send anything on its own`() = runTest {
        loadInvoice(paidInvoice())
        viewModel.promptArchive()
        advanceUntilIdle()
        assertTrue(viewModel.uiState.value.archivePrompt)
        assertNull(viewModel.uiState.value.archiveOwedCents)
        coVerify(exactly = 0) { invoiceRepository.archiveInvoice(any()) }
    }
    @Test
    fun `confirming archives a settled invoice`() = runTest {
        loadInvoice(paidInvoice())
        coEvery { invoiceRepository.archiveInvoice("i1") } returns Result.success(0)
        viewModel.promptArchive()
        viewModel.confirmArchive()
        advanceUntilIdle()
        coVerify { invoiceRepository.archiveInvoice("i1") }
        assertFalse(viewModel.uiState.value.archivePrompt)
        assertEquals("Invoice archived.", viewModel.uiState.value.toastMessage)
    }
    @Test
    fun `#2090 an owed invoice's Archive says why it cannot and offers the write-off, sending nothing`() = runTest {
        loadInvoice(openInvoice())
        viewModel.promptArchive()
        advanceUntilIdle()
        assertTrue(viewModel.uiState.value.archivePrompt)
        assertEquals(4000L, viewModel.uiState.value.archiveOwedCents)
        coVerify(exactly = 0) { invoiceRepository.archiveInvoice(any()) }
        viewModel.promptWriteOff(4000L)
        assertFalse(viewModel.uiState.value.archivePrompt)
        assertEquals(4000L, viewModel.uiState.value.writeOffPromptCents)
    }
    @Test
    fun `#2090 a still-owing refusal from the server turns into the same prompt, not a failure`() = runTest {
        loadInvoice(paidInvoice())
        coEvery { invoiceRepository.archiveInvoice("i1") } returns Result.failure(
            RuntimeException(
                "This invoice still has \$12.50 owing, so it cannot be archived. Record the payment, or write off the balance first.",
            ),
        )
        viewModel.promptArchive()
        viewModel.confirmArchive()
        advanceUntilIdle()
        assertTrue(viewModel.uiState.value.archivePrompt)
        assertEquals(1250L, viewModel.uiState.value.archiveOwedCents)
        assertFalse(viewModel.uiState.value.toastVisible && viewModel.uiState.value.toastIsError)
    }
    @Test
    fun `#2090 the write-off writes off exactly the amount the confirm named`() = runTest {
        loadInvoice(openInvoice())
        coEvery { invoiceRepository.writeOffInvoice("i1", 4000L) } returns Result.success(4000L)
        viewModel.promptWriteOff(4000L)
        coVerify(exactly = 0) { invoiceRepository.writeOffInvoice(any(), any()) }
        viewModel.confirmWriteOff()
        advanceUntilIdle()
        coVerify(exactly = 1) { invoiceRepository.writeOffInvoice("i1", 4000L) }
        assertNull(viewModel.uiState.value.writeOffPromptCents)
        assertEquals(
            "Balance of \$40.00 written off. The household is no longer asked to pay it, and the invoice can be archived now.",
            viewModel.uiState.value.toastMessage,
        )
        assertFalse(viewModel.uiState.value.toastIsError)
    }
    @Test
    fun `#2090 a refused write-off says the server's words and writes nothing more`() = runTest {
        loadInvoice(openInvoice())
        coEvery { invoiceRepository.writeOffInvoice("i1", 4000L) } returns Result.failure(
            RuntimeException("The balance on this invoice is now \$15.00, not \$40.00. Check it and try again."),
        )
        viewModel.promptWriteOff(4000L)
        viewModel.confirmWriteOff()
        advanceUntilIdle()
        assertTrue(viewModel.uiState.value.toastIsError)
        assertTrue(viewModel.uiState.value.toastMessage.contains("now \$15.00"))
        assertNull(viewModel.uiState.value.writeOffPromptCents)
    }
    @Test
    fun `#2090 cancelling the write-off sends nothing`() = runTest {
        loadInvoice(openInvoice())
        viewModel.promptWriteOff(4000L)
        viewModel.dismissWriteOffPrompt()
        advanceUntilIdle()
        assertNull(viewModel.uiState.value.writeOffPromptCents)
        coVerify(exactly = 0) { invoiceRepository.writeOffInvoice(any(), any()) }
    }
    @Test
    fun `any other failure closes the prompt and reports verbatim`() = runTest {
        loadInvoice(paidInvoice())
        coEvery { invoiceRepository.archiveInvoice("i1") } returns
            Result.failure(RuntimeException("This invoice is already archived."))
        viewModel.promptArchive()
        viewModel.confirmArchive()
        advanceUntilIdle()
        assertFalse(viewModel.uiState.value.archivePrompt)
        assertTrue(viewModel.uiState.value.toastMessage.contains("already archived"))
    }
    @Test
    fun `an ARCHIVED invoice restores instead of archiving`() = runTest {
        loadInvoice(archivedInvoice())
        coEvery { invoiceRepository.unarchiveInvoice("i1") } returns Result.success("")
        viewModel.promptArchive()
        viewModel.confirmArchive()
        advanceUntilIdle()
        coVerify { invoiceRepository.unarchiveInvoice("i1") }
        coVerify(exactly = 0) { invoiceRepository.archiveInvoice(any()) }
        assertTrue(viewModel.uiState.value.toastMessage.contains("restored"))
    }
    @Test
    fun `#2168 archiving a draft says its visits are back on the un-invoiced list`() = runTest {
        loadInvoice(openInvoice().apply { status = "draft" })
        coEvery { invoiceRepository.archiveInvoice("i1") } returns Result.success(2)
        viewModel.promptArchive()
        viewModel.confirmArchive()
        advanceUntilIdle()
        assertEquals("Invoice archived. Its 2 visits are back on the un-invoiced list.", viewModel.uiState.value.toastMessage)
        assertFalse(viewModel.uiState.value.toastIsError)
    }
    @Test
    fun `#2168 a restore that could not take a visit back says which`() = runTest {
        loadInvoice(archivedInvoice())
        val notice = "1 visit could not be taken back: the visit on 2026-06-02 is now on invoice 1042. " +
            "Its line is still on this draft, so remove it in Edit before sending the draft."
        coEvery { invoiceRepository.unarchiveInvoice("i1") } returns Result.success(notice)
        viewModel.promptArchive()
        viewModel.confirmArchive()
        advanceUntilIdle()
        // A lasting warning, not the 4-second toast (#2168 review).
        assertEquals("Invoice restored to the working list. $notice", viewModel.uiState.value.restoreNotice)
        assertFalse(viewModel.uiState.value.toastVisible)
        viewModel.dismissRestoreNotice()
        assertEquals(null, viewModel.uiState.value.restoreNotice)
    }
    @Test
    fun `#2168 a plain restore is a toast and leaves no lasting notice`() = runTest {
        loadInvoice(archivedInvoice())
        coEvery { invoiceRepository.unarchiveInvoice("i1") } returns Result.success("")
        viewModel.promptArchive()
        viewModel.confirmArchive()
        advanceUntilIdle()
        assertEquals(null, viewModel.uiState.value.restoreNotice)
        assertTrue(viewModel.uiState.value.toastVisible)
        assertEquals("Invoice restored to the working list.", viewModel.uiState.value.toastMessage)
    }
    @Test
    fun `dismissing while a call is in flight does not close the prompt`() = runTest {
        loadInvoice(paidInvoice())
        // Stubbed even though this test never advances to it: `runTest` drains
        // the scheduler on the way out, and a relaxed mockk hands back a bare
        // Object that cannot be cast to the Result the coroutine awaits.
        coEvery { invoiceRepository.archiveInvoice("i1") } returns Result.success(0)
        viewModel.promptArchive()
        viewModel.confirmArchive()
        // Still in flight: the dispatcher has not been advanced.
        viewModel.dismissArchivePrompt()
        assertTrue(viewModel.uiState.value.archivePrompt)
    }
}
/** The pure helpers beside the ViewModel and in domain/InvoiceActions.kt. */
class InvoiceArchiveHelpersTest {
    @Test
    fun `#2090 reads the owed figure off the server's archive refusal`() {
        assertEquals(
            4000L,
            archiveRefusedOwedCents(
                "This invoice still has \$40.00 owing, so it cannot be archived. Record the payment, or write off the balance first.",
            ),
        )
        assertEquals(
            123456L,
            archiveRefusedOwedCents("This invoice still has \$1,234.56 owing, so it cannot be archived."),
        )
    }
    @Test
    fun `does not treat any other refusal as a money question`() {
        assertNull(archiveRefusedOwedCents("This invoice is already archived."))
        assertNull(archiveRefusedOwedCents("Sign in required."))
        assertNull(archiveRefusedOwedCents(""))
    }
    @Test
    fun `#2090 archiving never says it wrote anything off`() {
        assertEquals("Invoice archived.", archiveSuccessMessage(restoring = false))
        // #2168: the same words as admin web.
        assertEquals("Invoice archived. Its visit is back on the un-invoiced list.", archiveSuccessMessage(false, released = 1))
        assertEquals("Invoice restored to the working list.", archiveSuccessMessage(true, notice = ""))
        assertTrue(archiveSuccessMessage(restoring = true).contains("restored"))
    }
    @Test
    fun `#2090 the write-off is offered only on an open invoice with money owed that is not archived`() {
        val open = Invoice(id = "i1", total = 40.0, amountDue = 40.0).apply { status = "open"; amountDueCents = 4000L }
        assertEquals(4000L, invoiceWriteOffOwedCents(open))
        assertEquals(900L, invoiceWriteOffOwedCents(Invoice(amountDue = 9.0).apply { status = "open" }))
        assertNull(invoiceWriteOffOwedCents(Invoice(amountDue = 40.0).apply { status = "draft" }))
        assertNull(invoiceWriteOffOwedCents(Invoice(amountDue = 40.0).apply { status = "quote" }))
        assertNull(invoiceWriteOffOwedCents(Invoice(amountDue = 0.0).apply { status = "paid" }))
        assertNull(invoiceWriteOffOwedCents(Invoice(amountDue = 0.0).apply { status = "written_off" }))
        assertNull(invoiceWriteOffOwedCents(Invoice(amountDue = 40.0).apply { status = "open"; archivedAt = "ts" }))
    }
    @Test
    fun `#2090 the confirm names the household, the invoice number and the amount`() {
        assertEquals(
            "Write off \$9.00 on invoice 1027 for The Whitfields? The household will no longer be asked to pay it, " +
                "and it stops counting as outstanding. It is not recorded as a payment or as account credit, and it " +
                "cannot be undone.",
            writeOffConfirmText("The Whitfields", "1027", 900L),
        )
        assertEquals(
            "This invoice still has \$9.00 owing, so it cannot be archived. Record the payment, or write off the balance first.",
            cannotArchiveOwedText(900L),
        )
    }
    @Test
    fun `#2090 a written-off invoice is its own state, offers nothing, and an archived one drops Send reminder`() {
        assertEquals(InvoiceState.WRITTEN_OFF, invoiceStateOrNull(Invoice().apply { status = "written_off" }))
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(InvoiceState.WRITTEN_OFF))
        assertEquals(listOf(InvoiceAction.RECORD_PAYMENT), invoiceActionsOffered(InvoiceState.OPEN, archived = true))
    }
}
