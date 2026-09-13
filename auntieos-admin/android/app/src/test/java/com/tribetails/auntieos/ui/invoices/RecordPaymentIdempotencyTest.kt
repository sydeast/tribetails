package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.contracts.MarkInvoicePaidResult
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
 * TWO KEYS ARE ASSERTED, NOT ONE, because one press of Record is two callables:
 * `markInvoicePaid` writes the audit-grade row in the invoice's subcollection
 * (`ipay_`) and `recordPayment` writes the display row (`pay_`). Holding one and
 * re-minting the other would leave exactly half the duplicate in place, which is
 * the failure a single-key test would pass straight through.
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
        coEvery { invoiceRepo.createPayment(any(), any()) } returns Result.success("pay-1")
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

    private fun settled() = MarkInvoicePaidResult(
        ok = true,
        invoiceId = "inv1",
        paymentId = "ipay-1",
        state = "settled",
        totalCents = 12_000L,
        paidCents = 12_000L,
        amountDueCents = 0L,
        overpaidCents = 0L,
    )

    /** The `ipay_` keys `markInvoicePaid` was called with, in order. */
    private fun ledgerKeys(times: Int): List<String?> {
        val keys = mutableListOf<String?>()
        coVerify(exactly = times) {
            invoiceRepo.markInvoicePaid(any(), any(), any(), any(), captureNullable(keys))
        }
        return keys
    }

    /** The `pay_` keys `recordPayment` was called with, in order. */
    private fun displayKeys(times: Int): List<String?> {
        val keys = mutableListOf<String?>()
        coVerify(exactly = times) {
            invoiceRepo.createPayment(any(), captureNullable(keys))
        }
        return keys
    }

    @Test
    fun `one pair of keys is minted and held across the operator's own retry`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.markInvoicePaid(any(), any(), any(), any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.success(settled())
            val vm = loaded()
            advanceUntilIdle()
            val p = payment()

            vm.recordPayment(p)
            advanceUntilIdle()
            vm.recordPayment(p)
            advanceUntilIdle()

            val ledger = ledgerKeys(2)
            assertTrue(ledger[0]!!.matches(Regex("^ipay_\\d+_[a-z0-9]+$")))
            assertEquals(ledger[0], ledger[1])
            // The first attempt failed before the display row, so `recordPayment`
            // ran once — on the SECOND attempt, carrying the key minted with the
            // first. Its own duplicate is defended by the same held pair.
            val display = displayKeys(1)
            assertTrue(display[0]!!.matches(Regex("^pay_\\d+_[a-z0-9]+$")))
        }

    /**
     * The hold survives REPEATED failures, not just one. An operator who is
     * offline does not press twice and give up; the key has to still be the
     * first attempt's on the fourth press as much as on the second.
     *
     * WHAT THIS DOES NOT PROVE, said plainly rather than left to the title: the
     * `pay_` key being held across a retry. On every sequential path there is no
     * such retry to observe — `markInvoicePaid` either fails, and `recordPayment`
     * is never reached, or succeeds, and the pair is released before
     * `recordPayment` runs. The only reachable case is two presses OVERLAPPING
     * in flight, which is exactly why both keys are read outside the coroutine
     * in `recordPayment`, and which `UnconfinedTestDispatcher` cannot stage: it
     * runs each launch to completion at the point of the call. The `pay_` key's
     * shape and its release are covered by the two tests below; its hold under
     * overlap is asserted by construction, not by this file.
     */
    @Test
    fun `the ledger key survives repeated failures, not just the first retry`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.markInvoicePaid(any(), any(), any(), any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.failure(RuntimeException("internal")) andThen
                Result.success(settled())
            val vm = loaded()
            advanceUntilIdle()
            val p = payment()

            vm.recordPayment(p)
            advanceUntilIdle()
            vm.recordPayment(p)
            advanceUntilIdle()
            vm.recordPayment(p)
            advanceUntilIdle()

            val ledger = ledgerKeys(3)
            assertEquals(ledger[0], ledger[1])
            assertEquals(ledger[1], ledger[2])
        }

    @Test
    fun `an edited payment mints a new pair, because it is a different payment`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.markInvoicePaid(any(), any(), any(), any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.success(settled())
            val vm = loaded()
            advanceUntilIdle()

            vm.recordPayment(payment(amount = 120.0))
            advanceUntilIdle()
            // The operator corrects the amount in the still-open dialog. Holding
            // the key here would replay the first attempt and report $120 back as
            // though the correction had landed.
            vm.recordPayment(payment(amount = 60.0))
            advanceUntilIdle()

            val ledger = ledgerKeys(2)
            assertNotEquals(ledger[0], ledger[1])
        }

    @Test
    fun `a corrected reference number is an edit too, not the same payment retried`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.markInvoicePaid(any(), any(), any(), any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.success(settled())
            val vm = loaded()
            advanceUntilIdle()

            vm.recordPayment(payment(reference = "CHK-1"))
            advanceUntilIdle()
            vm.recordPayment(payment(reference = "CHK-2"))
            advanceUntilIdle()

            assertNotEquals(ledgerKeys(2)[0], ledgerKeys(2)[1])
        }

    @Test
    fun `a recorded payment releases the pair, so the next one is its own payment`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.markInvoicePaid(any(), any(), any(), any(), any()) } returns
                Result.success(settled())
            val vm = loaded()
            advanceUntilIdle()
            val p = payment()

            vm.recordPayment(p)
            advanceUntilIdle()
            vm.recordPayment(p)
            advanceUntilIdle()

            // Identical fields, but the first attempt landed: a household can pay
            // the same amount by the same method twice, and holding the key would
            // make the second payment a replay of the first — the invoice would
            // look settled by money the books never received.
            val ledger = ledgerKeys(2)
            assertNotEquals(ledger[0], ledger[1])
            val display = displayKeys(2)
            assertNotEquals(display[0], display[1])
        }

    /**
     * The display write is best-effort: this flow reports success and closes the
     * dialog whatever it does, so there is no retry surface behind which a held
     * `pay_` key could be of any use. A payment re-entered afterwards is a new
     * intent, and a stale key would make it a replay of the one before.
     */
    @Test
    fun `a failed display row does not pin the key to a submission already reported done`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.markInvoicePaid(any(), any(), any(), any(), any()) } returns
                Result.success(settled())
            coEvery { invoiceRepo.createPayment(any(), any()) } returns
                Result.failure(RuntimeException("internal"))
            val vm = loaded()
            advanceUntilIdle()
            val p = payment()

            vm.recordPayment(p)
            advanceUntilIdle()
            vm.recordPayment(p)
            advanceUntilIdle()

            assertNotEquals(displayKeys(2)[0], displayKeys(2)[1])
        }
}
