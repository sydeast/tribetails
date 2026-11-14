package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.contracts.decodeRecordPaymentResult
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
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #825: the payment keys, AuntieOS Android.
 *
 * THE OPERATOR'S OWN RETRY IS THE DANGEROUS PATH. The Firebase SDK reports
 * `INTERNAL` for a request that never reached the container AND for a write that
 * committed with only the reply lost, so the operator who sees "Couldn't record
 * payment" cannot tell which happened — and neither can the client. Pressing
 * Record again repairs the first case; in the second it used to put the same
 * money against the same bill twice, settling or overpaying an invoice on money
 * nobody collected, and crediting the household's `accountBalanceCents` a second
 * time. There are no refunds in this business, so that credit is spendable money
 * made from nothing.
 *
 * #2269: ONE KEY, because one press of Record is one `recordPayment` call
 * carrying an `apply`. It used to be two callables with a key each.
 *
 * Mirrors `auntieos-admin/src/components/InvoiceDetail.test.tsx`, and follows
 * `CommunicateBroadcastIdempotencyTest` (#814) case for case.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RecordPaymentIdempotencyTest {

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
        // The screen's other reads. Stubbed so the ViewModel can reach the state
        // where Record is pressable; none of them is what this test is about.
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

    /** A loaded screen, sitting on `inv1`, with the dialog's payment ready. */
    private fun loaded(): InvoiceDetailViewModel {
        val vm = InvoiceDetailViewModel(
            repository = repo,
            invoiceRepository = invoiceRepo,
            kinCareRepository = kinCareRepo,
        )
        vm.loadInvoice("inv1")
        return vm
    }

    private fun payment(amount: Double = 120.0, reference: String = "CHK-1") = Payment(
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        invoiceId = "inv1",
        invoiceNumber = "TT-1",
        amount = amount,
        date = "2026-05-01",
        paymentMethod = "check",
        referenceNumber = reference,
    )

    private fun settled() = Result.success(
        decodeRecordPaymentResult(
            mapOf(
                "ok" to true,
                "paymentId" to "pay-1",
                "application" to mapOf("invoiceId" to "inv1", "state" to "settled", "amountDueCents" to 0),
            ),
        ),
    )

    private fun lost() = Result.failure<com.tribetails.auntieos.data.contracts.RecordPaymentResult>(RuntimeException("internal"))

    /** The `pay_` keys the one `recordPayment` call was made with, in order. */
    private fun keys(times: Int): List<String?> {
        val keys = mutableListOf<String?>()
        coVerify(exactly = times) {
            invoiceRepo.recordPaymentOnInvoice(any(), any(), captureNullable(keys))
        }
        return keys
    }
    @Test
    fun `one key is minted and held across the operator's own retry`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen settled()
            val vm = loaded()
            advanceUntilIdle()
            val p = payment()
            vm.recordPayment(p, p.amount)
            advanceUntilIdle()
            vm.recordPayment(p, p.amount)
            advanceUntilIdle()
            val sent = keys(2)
            assertTrue(sent[0]!!.matches(Regex("^pay_\\d+_[a-z0-9]+$")))
            assertEquals(sent[0], sent[1])
            // #2269: nothing calls the old settlement step.
            coVerify(exactly = 0) { invoiceRepo.markInvoicePaid(any(), any(), any(), any(), any()) }
        }
    /**
     * The hold survives REPEATED failures, not just one. An operator who is
     * offline does not press twice and give up; the key has to still be the
     * first attempt's on the fourth press as much as on the second.
     */
    @Test
    fun `the key survives repeated failures, not just the first retry`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns
                lost() andThen lost() andThen settled()
            val vm = loaded()
            advanceUntilIdle()
            val p = payment()
            repeat(3) {
                vm.recordPayment(p, p.amount)
                advanceUntilIdle()
            }
            val sent = keys(3)
            assertEquals(sent[0], sent[1])
            assertEquals(sent[1], sent[2])
        }

    @Test
    fun `a failed call records nothing, keeps the dialog open and says why`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns
                Result.failure(RuntimeException("This invoice has been written off."))
            val vm = loaded()
            advanceUntilIdle()
            vm.openRecordPayment()
            vm.recordPayment(payment(), 120.0)
            advanceUntilIdle()
            val state = vm.uiState.value
            assertTrue(state.showRecordPayment)
            assertEquals("Couldn't record payment: This invoice has been written off.", state.toastMessage)
            assertTrue(state.toastIsError)
            coVerify(exactly = 0) { repo.logActivity(any()) }
        }
    @Test
    fun `an edited payment mints a new key, because it is a different payment`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen settled()
            val vm = loaded()
            advanceUntilIdle()
            vm.recordPayment(payment(amount = 120.0), 120.0)
            advanceUntilIdle()
            // The operator corrects the amount in the still-open dialog. Holding
            // the key here would replay the first attempt and report $120 back as
            // though the correction had landed.
            vm.recordPayment(payment(amount = 60.0), 60.0)
            advanceUntilIdle()
            val sent = keys(2)
            assertNotEquals(sent[0], sent[1])
        }
    /**
     * #982: the applied part is not on the [Payment], so it has to be in the
     * signature on its own. With a stated $200 payment, correcting the Amount
     * box leaves every Payment field unchanged; a held key would replay the
     * first apply.
     */
    @Test
    fun `a corrected applied amount on the same transaction mints a new key`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen settled()
            val vm = loaded()
            advanceUntilIdle()
            val p = payment(amount = 200.0)
            vm.recordPayment(p, 127.5)
            advanceUntilIdle()
            vm.recordPayment(p, 100.0)
            advanceUntilIdle()
            val sent = keys(2)
            assertNotEquals(sent[0], sent[1])
        }
    /**
     * #988: the same $200 with $20 moved from tip into account credit is a
     * different payment. Amount, applied part and every box but two are equal,
     * so only the credit in the signature tells a held key not to replay the
     * first submission's split.
     */
    @Test
    fun `a changed account credit on the same transaction mints a new key`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen settled()
            val vm = loaded()
            advanceUntilIdle()
            vm.recordPayment(payment(amount = 200.0).copy(tip = 72.5, creditToAccountCents = 0L), 127.5)
            advanceUntilIdle()
            vm.recordPayment(payment(amount = 200.0).copy(tip = 72.5, creditToAccountCents = 2_000L), 127.5)
            advanceUntilIdle()
            val sent = keys(2)
            assertNotEquals(sent[0], sent[1])
        }
    @Test
    fun `a corrected reference number is an edit too, not the same payment retried`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen settled()
            val vm = loaded()
            advanceUntilIdle()
            vm.recordPayment(payment(reference = "CHK-1"), 120.0)
            advanceUntilIdle()
            vm.recordPayment(payment(reference = "CHK-2"), 120.0)
            advanceUntilIdle()
            val sent = keys(2)
            assertNotEquals(sent[0], sent[1])
        }
    @Test
    fun `a recorded payment releases the key, so the next one is its own payment`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns settled()
            val vm = loaded()
            advanceUntilIdle()
            val p = payment()
            vm.recordPayment(p, p.amount)
            advanceUntilIdle()
            vm.recordPayment(p, p.amount)
            advanceUntilIdle()
            // Identical fields, but the first attempt landed: a household can pay
            // the same amount by the same method twice, and holding the key would
            // make the second payment a replay of the first, so the invoice would
            // look settled by money the books never received.
            val sent = keys(2)
            assertNotEquals(sent[0], sent[1])
        }
}
