package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.contracts.MarkInvoicePaidResult
import com.tribetails.auntieos.data.contracts.decodeRecordPaymentResult
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Payment
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #982: what `InvoiceDetailViewModel.recordPayment` sends to `markInvoicePaid`.
 *
 * `markInvoicePaid` puts money ON THE INVOICE. It must get the applied part
 * only, the dialog's Amount box, the same figure admin web sends from its Amount
 * box (`InvoiceDetail.tsx`, Mark paid). The tip is the tip and any leftover is
 * leftover; neither belongs on the invoice. The ledger row (`recordPayment`)
 * still carries the whole transaction, with the gross tip and the fee.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RecordPaymentMarkPaidAmountTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private lateinit var invoiceRepo: InvoiceRepository
    private lateinit var kinCareRepo: KinCareRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        invoiceRepo = mockk()
        kinCareRepo = mockk()
        coEvery { invoiceRepo.getInvoiceById("inv1") } returns Result.success(TestFixtures.invoice1)
        coEvery { invoiceRepo.getInvoiceLedger("inv1") } returns
            Result.success(TestFixtures.emptyInvoiceLedger("inv1"))
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.getBusinessSettings() } returns Result.failure(RuntimeException("not under test"))
        coEvery { repo.logActivity(any()) } returns Result.success(Unit)
        coEvery { invoiceRepo.markInvoicePaid(any(), any(), any(), any(), any()) } returns
            Result.success(
                MarkInvoicePaidResult(
                    ok = true,
                    invoiceId = "inv1",
                    paymentId = "ipay-1",
                    state = "settled",
                    totalCents = 12_750L,
                    paidCents = 12_750L,
                    amountDueCents = 0L,
                    overpaidCents = 0L,
                )
            )
        coEvery { invoiceRepo.recordInvoicePayment(any(), any(), any()) } returns
            Result.success(decodeRecordPaymentResult(mapOf("ok" to true, "paymentId" to "pay-1")))
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun invoice() = Invoice(
        id = "inv1",
        kinfolkId = "fam1",
        kinfolkName = "The Riveras",
        invoiceNumber = "1029",
        amountDue = 127.5,
        total = 127.5,
    )

    /** Exactly what the dialog builds from its boxes. */
    private fun dialog(amount: Double, tip: Double, fee: Double, paymentTotal: Double = 0.0): Payment =
        buildInvoicePayment(
            invoice = invoice(),
            amount = amount,
            paymentMethod = "venmo",
            referenceNumber = "VN-1029",
            date = "2026-09-27",
            notes = "",
            tip = tip,
            fee = fee,
            paymentTotal = paymentTotal,
            creditToAccount = if (paymentTotal > 0.0) paymentTotal - amount - tip else 0.0,
        )

    /** Runs one Record press and answers (markInvoicePaid amount, ledger payment). */
    private fun record(amount: Double, tip: Double, fee: Double, paymentTotal: Double = 0.0): Pair<Double?, Payment> {
        val vm = InvoiceDetailViewModel(
            repository = repo,
            invoiceRepository = invoiceRepo,
            kinCareRepository = kinCareRepo,
        )
        vm.loadInvoice("inv1")
        // The dialog hands over the transaction AND its Amount box.
        vm.recordPayment(dialog(amount, tip, fee, paymentTotal), amount)
        val applied = mutableListOf<Double?>()
        coVerify(exactly = 1) { invoiceRepo.markInvoicePaid("inv1", captureNullable(applied), any(), any(), any()) }
        val sent = mutableListOf<Payment>()
        coVerify(exactly = 1) { invoiceRepo.recordInvoicePayment(capture(sent), any(), any()) }
        return applied.single() to sent.single()
    }

    @Test
    fun `exact payment plus tip applies only the invoice amount`() = runTest(testDispatcher) {
        // $127.50 bill, $10 gross tip, $2.71 fee: the client handed over $137.50.
        val (applied, ledger) = record(amount = 127.5, tip = 10.0, fee = 2.71)
        advanceUntilIdle()
        assertEquals(127.5, applied!!, 0.0001)
        assertEquals(137.5, ledger.amount, 0.0001)
        assertEquals(10.0, ledger.tip, 0.0001)
        assertEquals(2.71, ledger.fee, 0.0001)
    }

    @Test
    fun `an overpayment applies only the invoice amount, the leftover stays off the invoice`() = runTest(testDispatcher) {
        // $200 in: $127.50 on the invoice, $10 tip, $62.50 left over.
        val (applied, ledger) = record(amount = 127.5, tip = 10.0, fee = 2.71, paymentTotal = 200.0)
        advanceUntilIdle()
        assertEquals(127.5, applied!!, 0.0001)
        assertEquals(200.0, ledger.amount, 0.0001)
        assertEquals(10.0, ledger.tip, 0.0001)
    }

    @Test
    fun `the toast repeats the server's credit in web's words, and only that`() = runTest(testDispatcher) {
        coEvery { invoiceRepo.recordInvoicePayment(any(), any(), any()) } returns
            Result.success(
                decodeRecordPaymentResult(
                    mapOf("ok" to true, "paymentId" to "pay-1", "creditedToAccountCents" to 6_250),
                )
            )
        val vm = InvoiceDetailViewModel(repository = repo, invoiceRepository = invoiceRepo, kinCareRepository = kinCareRepo)
        vm.loadInvoice("inv1")
        vm.recordPayment(dialog(127.5, 10.0, 2.71, paymentTotal = 200.0), 127.5)
        advanceUntilIdle()
        val state = vm.uiState.value
        assertFalse(state.recordingPayment)
        assertEquals(
            "Payment recorded. The invoice is paid in full. \$62.50 has been added to the " +
                "household's account credit, which goes onto their next invoice automatically.",
            state.toastMessage,
        )
    }
    @Test
    fun `the credit note says nothing when there was no credit or no answer`() {
        assertEquals("", recordPaymentCreditNote(null))
        assertEquals("", recordPaymentCreditNote(0L))
        assertEquals(
            " \$0.01 has been added to the household's account credit, " +
                "which goes onto their next invoice automatically.",
            recordPaymentCreditNote(1L),
        )
    }
    @Test
    fun `the wait shows a busy state until both calls have answered`() = runTest(testDispatcher) {
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        coEvery { invoiceRepo.recordInvoicePayment(any(), any(), any()) } coAnswers {
            gate.await()
            Result.success(decodeRecordPaymentResult(mapOf("ok" to true, "paymentId" to "pay-1")))
        }
        val vm = InvoiceDetailViewModel(repository = repo, invoiceRepository = invoiceRepo, kinCareRepository = kinCareRepo)
        vm.loadInvoice("inv1")
        vm.recordPayment(dialog(127.5, 10.0, 2.71), 127.5)
        assertTrue(vm.uiState.value.recordingPayment)
        gate.complete(Unit)
        advanceUntilIdle()
        assertFalse(vm.uiState.value.recordingPayment)
    }
    @Test
    fun `a partial payment applies only what she typed, not the tip with it`() = runTest(testDispatcher) {
        // $50 toward the $127.50 bill plus a $5 tip.
        val (applied, ledger) = record(amount = 50.0, tip = 5.0, fee = 0.0)
        advanceUntilIdle()
        assertEquals(50.0, applied!!, 0.0001)
        assertEquals(55.0, ledger.amount, 0.0001)
        assertEquals(5.0, ledger.tip, 0.0001)
    }
}
