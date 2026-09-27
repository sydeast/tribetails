package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.contracts.MarkInvoicePaidResult
import com.tribetails.auntieos.data.contracts.decodeRecordPaymentResult
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.recordPaymentArgs
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
import org.junit.Before
import org.junit.Test

/**
 * #977: Record payment with "Automatically apply any unapplied amount" ticked.
 *
 * `markInvoicePaid` settles the invoice first; `recordPayment` then writes the
 * ledger row for the whole transaction. The server works out the leftover by
 * reading the settlement row this call names, so the ledger payload has to
 * carry that id, the whole transaction, and no `apply`. The credit is the
 * server's figure; the client only carries it.
 *
 * Mirrors the `#977 Mark paid with auto-apply ticked` block in
 * `auntieos-admin/src/components/InvoiceDetail.test.tsx`, and the server's
 * `mytribe/functions/test/recordPaymentTwoStepAutoApply.test.ts`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RecordPaymentAutoApplyTwoStepTest {

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

    /** What the dialog submits for a $127.50 bill, a $10 gross tip and a $2.71 fee, box ticked. */
    private fun ticked(paymentTotal: Double = 0.0): Payment = buildInvoicePayment(
        invoice = invoice(),
        amount = 127.5,
        paymentMethod = "venmo",
        referenceNumber = "VN-1029",
        date = "2026-09-27",
        notes = "",
        tip = 10.0,
        fee = 2.71,
        paymentTotal = paymentTotal,
        autoApply = true,
    )

    private fun ledgerAnswer(creditedToAccountCents: Long) = decodeRecordPaymentResult(
        mapOf(
            "ok" to true,
            "paymentId" to "pay-1",
            "kinfolkId" to "fam1",
            "amountCents" to 13_750,
            "tipCents" to 1_000,
            "feeCents" to 271,
            "tipBasis" to "gross",
            "appliedCents" to 12_750,
            "unappliedCents" to 0,
            "proceedsCents" to 13_479,
            "tipNetCents" to 729,
            "autoApply" to true,
            "creditedToAccountCents" to creditedToAccountCents,
            "confirmationEmailSent" to false,
        )
    )

    @Test
    fun `the ledger payload is the whole transaction, names the settlement, and carries no apply`() {
        val payload = recordPaymentArgs(ticked(), "pay_1759000000000_abc123", "ipay-1").toPayload()
        assertEquals(137.5, payload["amount"])
        assertEquals(10.0, payload["tip"])
        assertEquals(2.71, payload["fee"])
        assertEquals(true, payload["autoApply"])
        assertEquals("inv1", payload["invoiceId"])
        assertEquals("1029", payload["invoiceNumber"])
        assertEquals("fam1", payload["kinfolkId"])
        assertEquals("ipay-1", payload["settledByInvoicePaymentId"])
        assertEquals("pay_1759000000000_abc123", payload["idempotencyKey"])
        assertFalse(payload.containsKey("apply"))
    }

    @Test
    fun `a stated payment total travels as the amount, so the server sees the real leftover`() {
        val payload = recordPaymentArgs(ticked(paymentTotal = 200.0), null, "ipay-1").toPayload()
        assertEquals(200.0, payload["amount"])
        assertEquals(10.0, payload["tip"])
        assertFalse(payload.containsKey("apply"))
    }

    @Test
    fun `the view model sends the ticked payment and the settlement id markInvoicePaid returned`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.recordInvoicePayment(any(), any(), any()) } returns
                Result.success(ledgerAnswer(0L))
            val vm = InvoiceDetailViewModel(
                repository = repo,
                invoiceRepository = invoiceRepo,
                kinCareRepository = kinCareRepo,
            )
            vm.loadInvoice("inv1")
            advanceUntilIdle()

            vm.recordPayment(ticked())
            advanceUntilIdle()

            val sent = mutableListOf<Payment>()
            val settledBy = mutableListOf<String?>()
            coVerify(exactly = 1) {
                invoiceRepo.recordInvoicePayment(capture(sent), any(), captureNullable(settledBy))
            }
            assertEquals(listOf<String?>("ipay-1"), settledBy)
            val p = sent.single()
            assertEquals(true, p.autoApply)
            assertEquals(137.5, p.amount, 0.0001)
            assertEquals(10.0, p.tip, 0.0001)
            assertEquals(2.71, p.fee, 0.0001)
            assertEquals("inv1", p.invoiceId)
            // No apply on the wire for this payment either.
            assertFalse(recordPaymentArgs(p, null, "ipay-1").toPayload().containsKey("apply"))
        }

    @Test
    fun `the credited amount is the server's figure, carried as sent`() {
        assertEquals(0L, ledgerAnswer(0L).creditedToAccountCents)
        assertEquals(6_250L, ledgerAnswer(6_250L).creditedToAccountCents)
    }
}
