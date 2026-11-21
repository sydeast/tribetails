package com.tribetails.auntieos.ui.invoices

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResultLedgerPayment
import com.tribetails.auntieos.data.contracts.decodeRecordPaymentResult
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
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

    /** #2297: the server's answer from the row an earlier press under the same key wrote. */
    private fun replayed() = Result.success(
        decodeRecordPaymentResult(
            mapOf(
                "ok" to true,
                "paymentId" to "pay-1",
                "application" to mapOf("invoiceId" to "inv1", "state" to "settled", "amountDueCents" to 0),
                "replayed" to true,
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
    fun `#2297 an edited payment keeps the key until an answer, because the first press may still commit`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen settled()
            val vm = loaded()
            advanceUntilIdle()
            vm.recordPayment(payment(amount = 120.0), 120.0)
            advanceUntilIdle()
            // The operator corrects the amount in the still-open dialog. A new
            // key here would let a late first press land beside this one.
            vm.recordPayment(payment(amount = 60.0), 60.0)
            advanceUntilIdle()
            val sent = keys(2)
            assertEquals(sent[0], sent[1])
            // Nothing was on record under the key, so the new figure is the payment.
            assertEquals("Payment recorded. The invoice is paid in full.", vm.uiState.value.toastMessage)
        }

    @Test
    fun `#2297 an edited payment answered from the first press says that earlier payment is on record`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen replayed()
            val vm = loaded()
            advanceUntilIdle()
            vm.openRecordPayment()
            vm.recordPayment(payment(amount = 120.0), 120.0)
            advanceUntilIdle()
            vm.recordPayment(payment(amount = 60.0), 60.0)
            advanceUntilIdle()
            val sent = keys(2)
            assertEquals(sent[0], sent[1])
            val state = vm.uiState.value
            // Not "paid in full" for the $60 just typed: the $120 press is the payment.
            assertEquals(PAYMENT_EARLIER_ON_RECORD, state.toastMessage)
            assertFalse(state.showRecordPayment)
            assertFalse(state.recordingPayment)
        }

    @Test
    fun `#2297 a same-figure retry answered from the first press reads as this payment`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen replayed()
            val vm = loaded()
            advanceUntilIdle()
            vm.openRecordPayment()
            vm.recordPayment(payment(), 120.0)
            advanceUntilIdle()
            vm.recordPayment(payment(), 120.0)
            advanceUntilIdle()
            assertEquals("Payment recorded. The invoice is paid in full.", vm.uiState.value.toastMessage)
        }
    /**
     * #982: the applied part is not on the [Payment], so it has to be in the
     * signature on its own. With a stated $200 payment, correcting the Amount
     * box leaves every Payment field unchanged. #2297: the key is held until an
     * answer; the signature is what tells a replay of the first apply apart.
     */
    @Test
    fun `a corrected applied amount on the same transaction keeps the key, and its replay is the earlier payment`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen replayed()
            val vm = loaded()
            advanceUntilIdle()
            val p = payment(amount = 200.0)
            vm.recordPayment(p, 127.5)
            advanceUntilIdle()
            vm.recordPayment(p, 100.0)
            advanceUntilIdle()
            val sent = keys(2)
            assertEquals(sent[0], sent[1])
            assertEquals(PAYMENT_EARLIER_ON_RECORD, vm.uiState.value.toastMessage)
        }
    /**
     * #988: the same $200 with $20 moved from tip into account credit is a
     * different payment. Amount, applied part and every box but two are equal,
     * so only the credit in the signature tells a replay of the first
     * submission's split apart (#2297: the key itself is held until an answer).
     */
    @Test
    fun `a changed account credit on the same transaction keeps the key, and its replay is the earlier payment`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen replayed()
            val vm = loaded()
            advanceUntilIdle()
            vm.recordPayment(payment(amount = 200.0).copy(tip = 72.5, creditToAccountCents = 0L), 127.5)
            advanceUntilIdle()
            vm.recordPayment(payment(amount = 200.0).copy(tip = 72.5, creditToAccountCents = 2_000L), 127.5)
            advanceUntilIdle()
            val sent = keys(2)
            assertEquals(sent[0], sent[1])
            assertEquals(PAYMENT_EARLIER_ON_RECORD, vm.uiState.value.toastMessage)
        }
    /**
     * #2297: reversed. A corrected reference, note, method or date after a lost
     * reply is the same payment retried. A new key there recorded it twice
     * when the first press had landed.
     */
    @Test
    fun `a corrected reference, note, method or date is the same payment retried`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen settled()
            val vm = loaded()
            advanceUntilIdle()
            vm.recordPayment(payment(reference = "CHK-1"), 120.0)
            advanceUntilIdle()
            vm.recordPayment(
                payment(reference = "CHK-2").copy(
                    notes = "paid at the door",
                    paymentMethod = "cash",
                    date = "2026-05-02",
                    sendConfirmationEmail = true,
                ),
                120.0,
            )
            advanceUntilIdle()
            val sent = keys(2)
            assertEquals(sent[0], sent[1])
        }

    private fun ledgerWith(vararg paymentIds: String) = TestFixtures.emptyInvoiceLedger("inv1").copy(
        ledgerPayments = paymentIds.map { id ->
            GetInvoiceLedgerResultLedgerPayment(
                paymentId = id,
                amountCents = 12000L,
                amountResolved = true,
                tipCents = 0L,
                feeCents = 0L,
                tipBasis = "gross",
                reconciles = true,
                appliedCents = 12000L,
                unappliedCents = 0L,
                proceedsCents = 12000L,
                autoApply = false,
                appliedInvoiceId = "inv1",
                appliedInvoiceNumber = "TT-1",
                method = "check",
                methodLabel = "Check",
                reference = "CHK-1",
                date = "2026-05-01",
                notes = "",
                recordedBy = null,
            )
        },
    )

    /** Every key a press sent, in order, captured as the calls are made. */
    private val sentKeys = mutableListOf<String?>()

    @Test
    fun `#2297 a failed press that landed is found, answered with the same key, and the form closes`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), captureNullable(sentKeys)) } returns lost() andThen settled()
            val vm = loaded()
            advanceUntilIdle()
            // The read after the failure lists the row the first press wrote.
            coEvery { invoiceRepo.getInvoiceLedger("inv1") } answers { Result.success(ledgerWith(sentKeys.first()!!)) }
            vm.openRecordPayment()
            vm.recordPayment(payment(), 120.0)
            advanceUntilIdle()
            val sent = keys(2)
            assertEquals(sent[0], sent[1])
            val state = vm.uiState.value
            assertFalse(state.showRecordPayment)
            assertFalse(state.recordingPayment)
            assertFalse(state.toastIsError)
        }

    @Test
    fun `#2297 a failed press that did not land keeps the form and the key`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen settled()
            val vm = loaded()
            advanceUntilIdle()
            vm.openRecordPayment()
            vm.recordPayment(payment(), 120.0)
            advanceUntilIdle()
            assertTrue(vm.uiState.value.showRecordPayment)
            assertTrue(vm.uiState.value.toastIsError)
            vm.recordPayment(payment(), 120.0)
            advanceUntilIdle()
            val sent = keys(2)
            assertEquals(sent[0], sent[1])
        }

    @Test
    fun `#2297 when the payments cannot be read the key is held, even for a changed amount`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen settled()
            val vm = loaded()
            advanceUntilIdle()
            coEvery { invoiceRepo.getInvoiceLedger("inv1") } returns Result.failure(RuntimeException("offline"))
            vm.openRecordPayment()
            vm.recordPayment(payment(amount = 120.0), 120.0)
            advanceUntilIdle()
            vm.recordPayment(payment(amount = 60.0), 60.0)
            advanceUntilIdle()
            val sent = keys(2)
            assertEquals(sent[0], sent[1])
        }

    @Test
    fun `#2297 Cancel keeps a failed press's key, and a replay in the next opening is the earlier payment`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen replayed()
            val vm = loaded()
            advanceUntilIdle()
            vm.openRecordPayment()
            vm.recordPayment(payment(), 120.0)
            advanceUntilIdle()
            vm.closeRecordPayment()
            vm.openRecordPayment()
            vm.recordPayment(payment(), 120.0)
            advanceUntilIdle()
            val sent = keys(2)
            assertEquals(sent[0], sent[1])
            // Same figures, but the form was closed in between: it may be a
            // second payment, so the operator is told which one is on record.
            assertEquals(PAYMENT_EARLIER_ON_RECORD, vm.uiState.value.toastMessage)
        }

    @Test
    fun `#2297 after Cancel a held key the server never saw records the new entry as usual`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns lost() andThen settled()
            val vm = loaded()
            advanceUntilIdle()
            vm.openRecordPayment()
            vm.recordPayment(payment(), 120.0)
            advanceUntilIdle()
            vm.closeRecordPayment()
            vm.openRecordPayment()
            vm.recordPayment(payment(amount = 90.0), 90.0)
            advanceUntilIdle()
            val sent = keys(2)
            assertEquals(sent[0], sent[1])
            assertEquals("Payment recorded. The invoice is paid in full.", vm.uiState.value.toastMessage)
        }

    @Test
    fun `#2297 a landed payment whose answer is lost twice says it was recorded and closes`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), captureNullable(sentKeys)) } returns lost() andThen lost()
            val vm = loaded()
            advanceUntilIdle()
            coEvery { invoiceRepo.getInvoiceLedger("inv1") } answers { Result.success(ledgerWith(sentKeys.first()!!)) }
            vm.openRecordPayment()
            vm.recordPayment(payment(), 120.0)
            advanceUntilIdle()
            val sent = keys(2)
            assertEquals(sent[0], sent[1])
            val state = vm.uiState.value
            assertFalse(state.showRecordPayment)
            assertEquals(PAYMENT_LANDED_NO_ANSWER, state.toastMessage)
        }

    @Test
    fun `#2297 a refusal from the server is not checked against the payments`() =
        runTest(testDispatcher) {
            val refusal = mockk<FirebaseFunctionsException>()
            every { refusal.code } returns FirebaseFunctionsException.Code.FAILED_PRECONDITION
            every { refusal.details } returns null
            every { refusal.message } returns "This invoice is already paid."
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) } returns Result.failure(refusal)
            val vm = loaded()
            advanceUntilIdle()
            vm.openRecordPayment()
            vm.recordPayment(payment(), 120.0)
            advanceUntilIdle()
            // One read on load, one quiet reload after the refusal; no check, and no second call.
            coVerify(exactly = 1) { invoiceRepo.recordPaymentOnInvoice(any(), any(), any()) }
            assertEquals("Couldn't record payment: This invoice is already paid.", vm.uiState.value.toastMessage)
            assertFalse(paymentMayHaveLanded(refusal))
            assertTrue(paymentMayHaveLanded(RuntimeException("internal")))
        }

    /**
     * #2297 review: the first press is refused (nothing recorded), the
     * corrected $60 press lands and its answer is lost. The row under the key
     * is the $60 one, so its replayed answer is this payment, not an earlier
     * press's: saying "the amounts typed after it were not recorded" here
     * would invite recording the $60 a second time.
     */
    @Test
    fun `#2297 a refused press, then a corrected one that landed with its answer lost, reports the corrected payment`() =
        runTest(testDispatcher) {
            val refusal = mockk<FirebaseFunctionsException>()
            every { refusal.code } returns FirebaseFunctionsException.Code.FAILED_PRECONDITION
            every { refusal.details } returns null
            every { refusal.message } returns "The invoice balance changed."
            val replayOfThisPress = Result.success(
                decodeRecordPaymentResult(
                    mapOf(
                        "ok" to true,
                        "paymentId" to "pay-1",
                        "amountCents" to 6000,
                        "appliedCents" to 6000,
                        "application" to mapOf("invoiceId" to "inv1", "state" to "partial", "amountDueCents" to 6000),
                        "replayed" to true,
                    ),
                ),
            )
            coEvery { invoiceRepo.recordPaymentOnInvoice(any(), any(), captureNullable(sentKeys)) } returns
                Result.failure<com.tribetails.auntieos.data.contracts.RecordPaymentResult>(refusal) andThen
                lost() andThen replayOfThisPress
            val vm = loaded()
            advanceUntilIdle()
            coEvery { invoiceRepo.getInvoiceLedger("inv1") } answers { Result.success(ledgerWith(sentKeys.first()!!)) }
            vm.openRecordPayment()
            vm.recordPayment(payment(amount = 120.0), 120.0)
            advanceUntilIdle()
            vm.recordPayment(payment(amount = 60.0), 60.0)
            advanceUntilIdle()
            val sent = keys(3)
            assertEquals(sent[0], sent[2])
            val state = vm.uiState.value
            assertNotEquals(PAYMENT_EARLIER_ON_RECORD, state.toastMessage)
            assertFalse(state.toastIsError)
            assertFalse(state.showRecordPayment)
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
