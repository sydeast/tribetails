package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.contracts.RecordPaymentResult
import com.tribetails.auntieos.data.contracts.decodeRecordPaymentResult
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.recordPaymentArgs
import com.tribetails.auntieos.data.repository.recordPaymentOnInvoiceArgs
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
 * #2269/#2230: Record payment is ONE `recordPayment` call carrying an `apply`.
 *
 * It used to be two: `markInvoicePaid` settled the invoice, then
 * `recordPayment` wrote the ledger row and sent the confirmation. An app closed
 * between the two left a paid invoice with no ledger row and nobody told, and
 * the server worked out the new balance from a read taken outside its
 * transaction, so two payments at once could leave the balance out of step.
 * The server now does the apply, the ledger row, the credit and the notice in
 * one transaction, the same request the desktop console sends
 * (`recordPaymentPayload`, #881).
 *
 * The old ledger-row-only request ([recordPaymentArgs], no apply) is still the
 * shape installed older builds send after their `markInvoicePaid` step, and a
 * test below pins it unchanged.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RecordPaymentOneCallTest {

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

    /** What the dialog submits for a $127.50 bill, a $10 gross tip and a $2.71 fee. */
    private fun dialog(paymentTotal: Double = 0.0): Payment = buildInvoicePayment(
        invoice = invoice(),
        amount = 127.5,
        paymentMethod = "venmo",
        referenceNumber = "VN-1029",
        date = "2026-09-27",
        notes = "",
        tip = 10.0,
        fee = 2.71,
        paymentTotal = paymentTotal,
        // #988: a stated total leaves its leftover as the credit she chose here;
        // with no total there is no leftover and no credit.
        creditToAccount = if (paymentTotal > 0.0) paymentTotal - 127.5 - 10.0 else 0.0,
    )

    private fun answer(
        state: String,
        amountDueCents: Long = 0L,
        overpaidCents: Long = 0L,
        creditedToAccountCents: Long = 0L,
    ): Result<RecordPaymentResult> = Result.success(
        decodeRecordPaymentResult(
            mapOf(
                "ok" to true,
                "paymentId" to "pay-1",
                "kinfolkId" to "fam1",
                "creditedToAccountCents" to creditedToAccountCents,
                "application" to mapOf(
                    "invoiceId" to "inv1",
                    "invoiceNumber" to "1029",
                    "paymentId" to "sub-1",
                    "appliedCents" to 12_750,
                    "state" to state,
                    "totalCents" to 12_750,
                    "paidCents" to 12_750 - amountDueCents,
                    "amountDueCents" to amountDueCents,
                    "overpaidCents" to overpaidCents,
                ),
            ),
        ),
    )

    private fun loaded(): InvoiceDetailViewModel {
        val vm = InvoiceDetailViewModel(
            repository = repo,
            invoiceRepository = invoiceRepo,
            kinCareRepository = kinCareRepo,
        )
        vm.loadInvoice("inv1")
        return vm
    }

    @Test
    fun `the request is the whole transaction plus an apply of the applied part`() {
        val payload = recordPaymentOnInvoiceArgs(dialog(), 127.5, "pay_1759000000000_abc123").toPayload()
        assertEquals(137.5, payload["amount"])
        assertEquals(10.0, payload["tip"])
        assertEquals(2.71, payload["fee"])
        assertEquals(false, payload["autoApply"])
        assertEquals(0L, payload["creditToAccountCents"])
        assertEquals("inv1", payload["invoiceId"])
        assertEquals("1029", payload["invoiceNumber"])
        assertEquals("fam1", payload["kinfolkId"])
        assertEquals("pay_1759000000000_abc123", payload["idempotencyKey"])
        assertEquals(mapOf("invoiceId" to "inv1", "invoiceNumber" to "1029", "amount" to 127.5), payload["apply"])
        // No markInvoicePaid step came first, so there is no settlement to name.
        assertFalse(payload.containsKey("settledByInvoicePaymentId"))
    }

    @Test
    fun `a stated payment total travels as the amount, with the chosen credit, and the apply stays the applied part`() {
        val payload = recordPaymentOnInvoiceArgs(dialog(paymentTotal = 200.0), 127.5).toPayload()
        assertEquals(200.0, payload["amount"])
        assertEquals(10.0, payload["tip"])
        assertEquals(true, payload["autoApply"])
        assertEquals(6_250L, payload["creditToAccountCents"])
        assertEquals(127.5, (payload["apply"] as Map<*, *>)["amount"])
        assertFalse(payload.containsKey("idempotencyKey"))
    }

    @Test
    fun `one press makes one recordPayment call with the applied part, and never markInvoicePaid`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns answer("settled")
            val vm = loaded()
            advanceUntilIdle()

            vm.recordPayment(dialog(), 127.5)
            advanceUntilIdle()

            val sent = mutableListOf<Payment>()
            val applied = mutableListOf<Double>()
            coVerify(exactly = 1) { invoiceRepo.recordPaymentOnInvoice(capture(sent), capture(applied), any()) }
            coVerify(exactly = 0) { invoiceRepo.markInvoicePaid(any(), any(), any(), any(), any()) }
            coVerify(exactly = 0) { invoiceRepo.recordInvoicePayment(any(), any(), any()) }
            assertEquals(127.5, applied.single(), 0.0001)
            val p = sent.single()
            assertEquals(137.5, p.amount, 0.0001)
            assertEquals(10.0, p.tip, 0.0001)
            assertEquals(2.71, p.fee, 0.0001)
            assertEquals("inv1", p.invoiceId)
            val state = vm.uiState.value
            assertFalse(state.recordingPayment)
            assertFalse(state.showRecordPayment)
            assertEquals("Payment recorded. The invoice is paid in full.", state.toastMessage)
            assertFalse(state.toastIsError)
        }

    @Test
    fun `a partial says what is still owed, from the server's application`() = runTest(testDispatcher) {
        coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns
            answer("partial", amountDueCents = 2_000L)
        val vm = loaded()
        advanceUntilIdle()
        vm.recordPayment(dialog(), 107.5)
        advanceUntilIdle()
        assertEquals(
            "Partial payment recorded. \$20.00 is still owed, and the invoice stays open.",
            vm.uiState.value.toastMessage,
        )
    }

    @Test
    fun `an overpaid invoice names the excess, and the credit she chose is added`() = runTest(testDispatcher) {
        coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns
            answer("overpaid", overpaidCents = 50L, creditedToAccountCents = 6_250L)
        val vm = loaded()
        advanceUntilIdle()
        vm.recordPayment(dialog(paymentTotal = 200.0), 127.5)
        advanceUntilIdle()
        assertEquals(
            "Payment recorded and the invoice is settled. It was overpaid by \$0.50, which has not been turned " +
                "into a credit. \$62.50 has been added to the household's account credit. It stays there until " +
                "you apply an amount to an invoice.",
            vm.uiState.value.toastMessage,
        )
    }

    @Test
    fun `an answer with no application does not claim the invoice is paid`() = runTest(testDispatcher) {
        coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns
            Result.success(decodeRecordPaymentResult(mapOf("ok" to true, "paymentId" to "pay-1")))
        val vm = loaded()
        advanceUntilIdle()
        vm.recordPayment(dialog(), 127.5)
        advanceUntilIdle()
        assertTrue(vm.uiState.value.toastMessage.orEmpty().contains("did not report where the invoice now stands"))
    }

    @Test
    fun `a refused call records nothing, so no audit line is written and the dialog stays`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns
                Result.failure(RuntimeException("\$150.00 is more than the \$127.50 still owed on this invoice."))
            val vm = loaded()
            advanceUntilIdle()
            vm.openRecordPayment()
            vm.recordPayment(dialog(), 150.0)
            advanceUntilIdle()
            val state = vm.uiState.value
            assertTrue(state.showRecordPayment)
            assertFalse(state.recordingPayment)
            assertTrue(state.toastIsError)
            assertEquals(
                "Couldn't record payment: \$150.00 is more than the \$127.50 still owed on this invoice.",
                state.toastMessage,
            )
            coVerify(exactly = 0) { repo.logActivity(any()) }
        }

    @Test
    fun `the old ledger-row request older builds send is unchanged and carries no apply`() {
        val payload = recordPaymentArgs(dialog(), "pay_1759000000000_abc123", "ipay-1").toPayload()
        assertEquals(137.5, payload["amount"])
        assertEquals("ipay-1", payload["settledByInvoicePaymentId"])
        assertFalse(payload.containsKey("apply"))
    }

    @Test
    fun `the credited amount is the server's figure, carried as sent`() {
        assertEquals(0L, answer("settled").getOrThrow().creditedToAccountCents)
        assertEquals(6_250L, answer("settled", creditedToAccountCents = 6_250L).getOrThrow().creditedToAccountCents)
    }
}
