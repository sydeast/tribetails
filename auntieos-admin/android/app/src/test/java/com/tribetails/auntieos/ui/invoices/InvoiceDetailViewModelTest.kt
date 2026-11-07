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

    // ── #832: the already-sent answer ────────────────────────────────────────
    @Test
    fun `sendReminder refused as already sent says when, not Reminder sent, and moves only the stamp`() = runTest {
        val invoice = Invoice(id = "inv832", invoiceNumber = "INV-832", kinfolkName = "The Whitfields", total = 40.0, amountDue = 40.0)
        coEvery { invoiceRepository.getInvoiceById("inv832") } returns Result.success(invoice)
        viewModel.loadInvoice("inv832")
        advanceUntilIdle()

        val earlier = 1_757_840_400_000L
        coEvery { invoiceRepository.sendInvoiceReminder("inv832", any()) } returns Result.success(
            com.tribetails.auntieos.domain.ReminderOutcome(sent = false, reason = "recent", lastReminderAtMs = earlier, nextReminderAllowedAtMs = earlier + 86_400_000L),
        )
        viewModel.sendReminder()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.sendingReminder)
        assertTrue(state.toastVisible)
        assertTrue(state.toastMessage!!.startsWith("Not sent: a reminder already went out"))
        assertTrue(state.toastIsError)
        assertEquals(earlier, state.invoice!!.reminderNotifiedAtMs)
        // Every other field survives: a copy of the loaded model, never a rebuild.
        assertEquals(invoice.copy(reminderNotifiedAtMs = earlier), state.invoice)
    }

    // ── #1507: the app-only send ─────────────────────────────────────────────
    @Test
    fun `sendReminder that reached the household in the app only says so, not green, and moves the flag with the stamp`() = runTest {
        val invoice = Invoice(id = "inv1507", invoiceNumber = "INV-1507", kinfolkName = "The Whitfields", total = 40.0, amountDue = 40.0)
        coEvery { invoiceRepository.getInvoiceById("inv1507") } returns Result.success(invoice)
        viewModel.loadInvoice("inv1507")
        advanceUntilIdle()

        val now = 1_757_862_300_000L
        coEvery { invoiceRepository.sendInvoiceReminder("inv1507", any()) } returns Result.success(
            com.tribetails.auntieos.domain.ReminderOutcome(sent = true, reason = "sent", lastReminderAtMs = now, nextReminderAllowedAtMs = now + 86_400_000L, appOnly = true),
        )
        viewModel.sendReminder()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals("Reminder sent in the app only. Email and text are off for this household.", state.toastMessage)
        // Not a success toast: no email or text went out, and the tone agrees with the words.
        assertTrue(state.toastIsError)
        assertEquals(invoice.copy(reminderNotifiedAtMs = now, reminderNotifiedAppOnly = true), state.invoice)
    }

    @Test
    fun `sendReminder refused leaves the stored app-only flag alone`() = runTest {
        val invoice = Invoice(id = "inv1508", invoiceNumber = "INV-1508", kinfolkName = "The Whitfields", total = 40.0, amountDue = 40.0, reminderNotifiedAppOnly = true)
        coEvery { invoiceRepository.getInvoiceById("inv1508") } returns Result.success(invoice)
        viewModel.loadInvoice("inv1508")
        advanceUntilIdle()

        val earlier = 1_757_840_400_000L
        coEvery { invoiceRepository.sendInvoiceReminder("inv1508", any()) } returns Result.success(
            com.tribetails.auntieos.domain.ReminderOutcome(sent = false, reason = "recent", lastReminderAtMs = earlier, nextReminderAllowedAtMs = earlier + 86_400_000L),
        )
        viewModel.sendReminder()
        advanceUntilIdle()

        // A refusal names the earlier reminder's time and knows nothing of its channels.
        assertEquals(invoice.copy(reminderNotifiedAtMs = earlier, reminderNotifiedAppOnly = true), viewModel.uiState.value.invoice)
    }

    @Test
    fun `resendQuote that reached the household in the app only says so, not green`() = runTest {
        val quote = Invoice(id = "q1507", invoiceNumber = "Q-1507", kinfolkName = "The Whitfields", total = 240.0, amountDue = 240.0, status = "quote", quoteDecision = "denied")
        coEvery { invoiceRepository.getInvoiceById("q1507") } returns Result.success(quote)
        viewModel.loadInvoice("q1507")
        advanceUntilIdle()

        coEvery { invoiceRepository.resendQuote("q1507") } returns Result.success(
            com.tribetails.auntieos.data.contracts.ResendQuoteResult(ok = true, invoiceId = "q1507", status = "quote", appOnly = true),
        )
        viewModel.resendQuote()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.resendingQuote)
        assertEquals(
            "Quote sent again, in the app only. Email and text are off for this household. The household can accept or decline it now.",
            state.toastMessage,
        )
        assertTrue(state.toastIsError)
    }

    @Test
    fun `resendQuote from an older server, with no flag, keeps the plain green toast`() = runTest {
        val quote = Invoice(id = "q1508", invoiceNumber = "Q-1508", kinfolkName = "The Whitfields", total = 240.0, amountDue = 240.0, status = "quote", quoteDecision = "denied")
        coEvery { invoiceRepository.getInvoiceById("q1508") } returns Result.success(quote)
        viewModel.loadInvoice("q1508")
        advanceUntilIdle()

        coEvery { invoiceRepository.resendQuote("q1508") } returns Result.success(
            com.tribetails.auntieos.data.contracts.ResendQuoteResult(ok = true, invoiceId = "q1508", status = "quote"),
        )
        viewModel.resendQuote()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals("Quote sent again. The household can accept or decline it now.", state.toastMessage)
        assertFalse(state.toastIsError)
    }

    // ── #1511: the receipt and the draft send ────────────────────────────────
    @Test
    fun `generateReceipt that reached the household in the app only says so, not green`() = runTest {
        val paid = Invoice(id = "inv1511", invoiceNumber = "INV-1511", kinfolkName = "The Whitfields", total = 40.0, amountDue = 0.0, status = "paid")
        coEvery { invoiceRepository.getInvoiceById("inv1511") } returns Result.success(paid)
        viewModel.loadInvoice("inv1511")
        advanceUntilIdle()

        coEvery { invoiceRepository.generateReceipt("inv1511") } returns Result.success(
            com.tribetails.auntieos.data.contracts.GenerateReceiptResult(ok = true, appOnly = true),
        )
        viewModel.generateReceipt()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.generatingReceipt)
        assertEquals("Receipt generated in the app only. Email and text are off for this household.", state.toastMessage)
        assertTrue(state.toastIsError)
    }

    @Test
    fun `generateReceipt from an older server, with no flag, keeps the plain green toast`() = runTest {
        val paid = Invoice(id = "inv1512", invoiceNumber = "INV-1512", kinfolkName = "The Whitfields", total = 40.0, amountDue = 0.0, status = "paid")
        coEvery { invoiceRepository.getInvoiceById("inv1512") } returns Result.success(paid)
        viewModel.loadInvoice("inv1512")
        advanceUntilIdle()

        coEvery { invoiceRepository.generateReceipt("inv1512") } returns Result.success(
            com.tribetails.auntieos.data.contracts.GenerateReceiptResult(ok = true),
        )
        viewModel.generateReceipt()
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals("Receipt generated.", state.toastMessage)
        assertFalse(state.toastIsError)
    }

    /**
     * A draft with a household on it: `loadInvoice` also loads that household's
     * kincare sessions, and a relaxed mockk answers a `Result<List>` with a bare
     * Object, so this screen's kincare repo is stubbed for the two draft cases.
     */
    private fun draftViewModel(kinfolkId: String): InvoiceDetailViewModel {
        val kinCare = mockk<com.tribetails.auntieos.data.repository.KinCareRepository>(relaxed = true)
        coEvery { kinCare.getKinCareSessionsForKinfolk(kinfolkId) } returns Result.success(emptyList())
        return InvoiceDetailViewModel(repository, invoiceRepository, kinCare)
    }

    @Test
    fun `reviewAndSendDraft that reached the household in the app only says so, not green`() = runTest {
        val draft = Invoice(id = "d1511", kinfolkId = "fam1", invoiceNumber = "INV-D", kinfolkName = "The Whitfields", total = 40.0, amountDue = 40.0, status = "draft")
        coEvery { invoiceRepository.getInvoiceById("d1511") } returns Result.success(draft)
        val vm = draftViewModel("fam1")
        vm.loadInvoice("d1511")
        advanceUntilIdle()

        coEvery { invoiceRepository.reviewAndSendDraftInvoice("d1511", "fam1") } returns Result.success(
            com.tribetails.auntieos.data.contracts.PostInvoiceEventResult(ok = true, appOnly = true),
        )
        vm.reviewAndSendDraft()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.sendingDraft)
        assertEquals("Draft sent in the app only. Email and text are off for this household.", state.toastMessage)
        assertTrue(state.toastIsError)
    }

    @Test
    fun `#1567 a draft send that got no answer is re-read and reported as sent`() = runTest {
        val draft = Invoice(id = "d1567", kinfolkId = "fam1", invoiceNumber = "INV-D", kinfolkName = "The Whitfields", total = 40.0, amountDue = 40.0, status = "draft")
        coEvery { invoiceRepository.getInvoiceById("d1567") } returns Result.success(draft)
        val vm = draftViewModel("fam1")
        vm.loadInvoice("d1567")
        advanceUntilIdle()
        coEvery { invoiceRepository.reviewAndSendDraftInvoice("d1567", "fam1") } returns Result.failure(
            io.mockk.mockk<com.google.firebase.functions.FirebaseFunctionsException>(relaxed = true).also {
                io.mockk.every { it.code } returns com.google.firebase.functions.FirebaseFunctionsException.Code.DEADLINE_EXCEEDED
            },
        )
        coEvery { invoiceRepository.readInvoiceSendMarks("d1567") } returns
            com.tribetails.auntieos.domain.SendMarks("open", null, null, null)
        vm.reviewAndSendDraft()
        advanceUntilIdle()
        val state = vm.uiState.value
        assertFalse(state.sendingDraft)
        assertEquals("Draft sent. The answer came late, so this was confirmed by re-reading the invoice.", state.toastMessage)
        assertFalse(state.toastIsError)
    }
    @Test
    fun `#1567 a draft send whose re-read fails says it cannot tell`() = runTest {
        val draft = Invoice(id = "d1568", kinfolkId = "fam1", invoiceNumber = "INV-D", kinfolkName = "The Whitfields", total = 40.0, amountDue = 40.0, status = "draft")
        coEvery { invoiceRepository.getInvoiceById("d1568") } returns Result.success(draft)
        val vm = draftViewModel("fam1")
        vm.loadInvoice("d1568")
        advanceUntilIdle()
        coEvery { invoiceRepository.reviewAndSendDraftInvoice("d1568", "fam1") } returns Result.failure(
            java.net.SocketTimeoutException("timeout"),
        )
        coEvery { invoiceRepository.readInvoiceSendMarks("d1568") } returns null
        vm.reviewAndSendDraft()
        advanceUntilIdle()
        val state = vm.uiState.value
        assertTrue(state.toastMessage.contains("no way to tell from here whether the draft went"))
        assertTrue(state.toastIsError)
    }
    @Test
    fun `#1567 a server refusal is still reported verbatim, with no re-read`() = runTest {
        val draft = Invoice(id = "d1569", kinfolkId = "fam1", invoiceNumber = "INV-D", kinfolkName = "The Whitfields", total = 40.0, amountDue = 40.0, status = "draft")
        coEvery { invoiceRepository.getInvoiceById("d1569") } returns Result.success(draft)
        val vm = draftViewModel("fam1")
        vm.loadInvoice("d1569")
        advanceUntilIdle()
        coEvery { invoiceRepository.reviewAndSendDraftInvoice("d1569", "fam1") } returns Result.failure(
            IllegalStateException("Invoice is not a draft; nothing to send."),
        )
        vm.reviewAndSendDraft()
        advanceUntilIdle()
        assertEquals("Couldn't send draft: Invoice is not a draft; nothing to send.", vm.uiState.value.toastMessage)
        io.mockk.coVerify(exactly = 0) { invoiceRepository.readInvoiceSendMarks("d1569") }
    }
    @Test
    fun `reviewAndSendDraft by a channel keeps the plain green toast`() = runTest {
        val draft = Invoice(id = "d1512", kinfolkId = "fam1", invoiceNumber = "INV-D", kinfolkName = "The Whitfields", total = 40.0, amountDue = 40.0, status = "draft")
        coEvery { invoiceRepository.getInvoiceById("d1512") } returns Result.success(draft)
        val vm = draftViewModel("fam1")
        vm.loadInvoice("d1512")
        advanceUntilIdle()

        coEvery { invoiceRepository.reviewAndSendDraftInvoice("d1512", "fam1") } returns Result.success(
            com.tribetails.auntieos.data.contracts.PostInvoiceEventResult(ok = true, appOnly = false),
        )
        vm.reviewAndSendDraft()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertEquals("Draft sent.", state.toastMessage)
        assertFalse(state.toastIsError)
    }

    @Test
    fun `sendReminder is pessimistic, a second tap while in flight fires nothing`() = runTest {
        val invoice = Invoice(id = "inv833", invoiceNumber = "INV-833")
        coEvery { invoiceRepository.getInvoiceById("inv833") } returns Result.success(invoice)
        viewModel.loadInvoice("inv833")
        advanceUntilIdle()
        coEvery { invoiceRepository.sendInvoiceReminder("inv833", any()) } returns Result.success(
            com.tribetails.auntieos.domain.ReminderOutcome(sent = false, reason = "recent", lastReminderAtMs = 1L, nextReminderAllowedAtMs = 2L),
        )

        viewModel.sendReminder()
        assertTrue(viewModel.uiState.value.sendingReminder)
        viewModel.sendReminder()
        advanceUntilIdle()

        io.mockk.coVerify(exactly = 1) { invoiceRepository.sendInvoiceReminder("inv833", any()) }
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
