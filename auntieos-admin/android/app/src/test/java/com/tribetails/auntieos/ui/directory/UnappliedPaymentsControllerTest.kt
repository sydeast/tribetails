package com.tribetails.auntieos.ui.directory

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.contracts.ListUnappliedPaymentsResult
import com.tribetails.auntieos.data.contracts.ListUnappliedPaymentsResultOpenInvoice
import com.tribetails.auntieos.data.contracts.ListUnappliedPaymentsResultPayment
import com.tribetails.auntieos.data.contracts.ResolveUnappliedPaymentResult
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.domain.DECIDE_NEED_REASON
import com.tribetails.auntieos.domain.DecideForm
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1003: the "Payments needing a decision" list and its Decide dialog on
 * Android admin. The key is per submission: kept through a failed save so the
 * retry reuses it, fresh after a success or any changed input. The request is
 * built from the four form fields only.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class UnappliedPaymentsControllerTest {

    private fun payment(id: String = "evt_1", cents: Long = 2500L) = ListUnappliedPaymentsResultPayment(
        paymentId = id, kinfolkId = "fam1", invoiceId = "inv42", invoiceNumber = "INV-1042",
        amountCents = cents, amountResolved = true, feeCents = 0L,
        reason = "the invoice was already marked paid", receivedAtMs = 1_790_000_000_000L, referenceNumber = "",
    )

    private fun listed(vararg payments: ListUnappliedPaymentsResultPayment) = ListUnappliedPaymentsResult(
        ok = true, kinfolkId = "fam1", payments = payments.toList(),
        openInvoices = listOf(ListUnappliedPaymentsResultOpenInvoice("inv50", "INV-1050", 4000L)),
    )

    private fun resolved() = ResolveUnappliedPaymentResult(
        ok = true, paymentId = "evt_1", kinfolkId = "fam1", paymentCents = 2500L, creditedCents = 1000L,
        creditId = "upd_1", appliedCents = 1500L, appliedInvoiceId = "inv50", appliedInvoiceNumber = "INV-1050",
        appliedInvoiceState = "settled", appliedInvoiceAmountDueCents = 0L, keptCents = 0L,
        newAccountBalanceCents = 9999L, replayed = false,
    )

    private var minted = 0
    private val mint = { minted += 1; "upd_1790000000000_k$minted" }
    private val saved = mutableListOf<String>()

    private fun setup(
        scope: TestScope,
        repo: InvoiceRepository,
        list: ListUnappliedPaymentsResult = listed(payment()),
    ): UnappliedPaymentsController {
        coEvery { repo.listUnappliedPayments("fam1") } returns Result.success(list)
        val c = UnappliedPaymentsController(repo, scope, mint, onSaved = { saved += it })
        c.load("fam1")
        scope.advanceUntilIdle()
        return c
    }

    private fun UnappliedPaymentsController.fill(
        credit: String = "10.00",
        reason: String = "Overpaid",
        invoice: String = "inv50",
        apply: String = "15.00",
    ) {
        open("evt_1"); setCredit(credit); setReason(reason); setApplyInvoice(invoice); setApply(apply)
    }

    @Test
    fun `lists the payments and shows the section`() = runTest(StandardTestDispatcher()) {
        val c = setup(this, mockk())
        assertEquals(listOf("evt_1"), c.state.value.payments.map { it.paymentId })
        assertTrue(c.state.value.showSection)
    }

    @Test
    fun `an empty list hides the section`() = runTest(StandardTestDispatcher()) {
        val c = setup(this, mockk(), listed())
        assertFalse(c.state.value.showSection)
    }

    @Test
    fun `an empty list opened from the notice still shows the section`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        coEvery { repo.listUnappliedPayments("fam1") } returns Result.success(listed())
        val c = UnappliedPaymentsController(repo, this, mint)
        c.openFromNotice("fam1", "evt_gone")
        c.load("fam1")
        advanceUntilIdle()
        assertTrue(c.state.value.fromNotice)
        assertTrue(c.state.value.showSection)
        assertNull(c.state.value.dialogPaymentId)
    }

    @Test
    fun `the notice opens that payment's dialog when it is listed`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        coEvery { repo.listUnappliedPayments("fam1") } returns Result.success(listed(payment("evt_0"), payment("evt_1")))
        val c = UnappliedPaymentsController(repo, this, mint)
        c.openFromNotice("fam1", "evt_1")
        c.load("fam1")
        advanceUntilIdle()
        assertEquals("evt_1", c.state.value.dialogPaymentId)

        // A plain visit later is not the notice: no dialog forced open, flag cleared.
        c.dismiss()
        c.load("fam1")
        advanceUntilIdle()
        assertFalse(c.state.value.fromNotice)
        assertNull(c.state.value.dialogPaymentId)
    }

    @Test
    fun `a notice for another household is not consumed by this one`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        coEvery { repo.listUnappliedPayments("fam1") } returns Result.success(listed(payment()))
        val c = UnappliedPaymentsController(repo, this, mint)
        c.openFromNotice("fam2", "evt_1")
        c.load("fam1")
        advanceUntilIdle()
        assertFalse(c.state.value.fromNotice)
        assertNull(c.state.value.dialogPaymentId)
    }

    @Test
    fun `permission-denied hides the section silently`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val denied = mockk<FirebaseFunctionsException>()
        every { denied.code } returns FirebaseFunctionsException.Code.PERMISSION_DENIED
        coEvery { repo.listUnappliedPayments("fam1") } returns Result.failure(denied)
        val c = UnappliedPaymentsController(repo, this, mint)
        c.load("fam1")
        advanceUntilIdle()
        assertFalse(c.state.value.visible)
        assertFalse(c.state.value.showSection)
        assertNull(c.state.value.loadError)
    }

    @Test
    fun `any other load failure shows the error, and Retry reads again`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        coEvery { repo.listUnappliedPayments("fam1") } returnsMany listOf(
            Result.failure(RuntimeException("offline")),
            Result.success(listed(payment())),
        )
        val c = UnappliedPaymentsController(repo, this, mint)
        c.load("fam1")
        advanceUntilIdle()
        assertEquals("Could not load payments needing a decision.", c.state.value.loadError)
        assertTrue(c.state.value.showSection)

        c.reload()
        advanceUntilIdle()
        assertNull(c.state.value.loadError)
        assertEquals(1, c.state.value.payments.size)
    }

    @Test
    fun `an invalid form refuses before any call and mints nothing`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        c.fill(reason = "  ")
        assertEquals(DecideForm.Invalid(DECIDE_NEED_REASON), c.state.value.form)
        c.save()
        advanceUntilIdle()
        assertEquals(0, minted)
        assertFalse(c.state.value.busy)
        coVerify(exactly = 0) { repo.resolveUnappliedPayment(any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `save sends only what the fields parse to, then closes, reloads, refreshes credit and notes the server's figures`() =
        runTest(StandardTestDispatcher()) {
            val repo = mockk<InvoiceRepository>()
            val c = setup(this, repo)
            coEvery { repo.resolveUnappliedPayment(any(), any(), any(), any(), any(), any()) } returns
                Result.success(resolved())
            c.fill(reason = "  Overpaid ")
            c.save()
            advanceUntilIdle()
            coVerify(exactly = 1) {
                repo.resolveUnappliedPayment("evt_1", 1000L, "Overpaid", "inv50", 1500L, "upd_1790000000000_k1")
            }

            assertNull(c.state.value.dialogPaymentId)
            assertEquals(
                "Decision saved. $10.00 to account credit (balance now $99.99). " +
                    "$15.00 on invoice INV-1050 (paid in full). $0.00 kept on the payment.",
                c.state.value.message,
            )
            coVerify(exactly = 2) { repo.listUnappliedPayments("fam1") }
            assertEquals(listOf("fam1"), saved)
            assertNull(c.pendingKey)

            c.fill()
            c.save()
            assertEquals("upd_1790000000000_k2", c.pendingKey)
        }

    @Test
    fun `the all-zero keep decision sends zeros and empty strings`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        coEvery { repo.resolveUnappliedPayment("evt_1", 0L, "", "", 0L, any()) } returns Result.success(resolved())
        c.open("evt_1")
        c.save()
        advanceUntilIdle()
        coVerify(exactly = 1) { repo.resolveUnappliedPayment("evt_1", 0L, "", "", 0L, "upd_1790000000000_k1") }
    }

    @Test
    fun `a failed save keeps the dialog open with the server message, and the retry reuses the key`() =
        runTest(StandardTestDispatcher()) {
            val repo = mockk<InvoiceRepository>()
            val c = setup(this, repo)
            val keys = mutableListOf<String>()
            coEvery { repo.resolveUnappliedPayment(any(), any(), any(), any(), any(), capture(keys)) } returnsMany listOf(
                Result.failure(RuntimeException("That invoice is already paid.")),
                Result.success(resolved()),
            )
            c.fill()
            c.save()
            advanceUntilIdle()
            assertEquals("evt_1", c.state.value.dialogPaymentId)
            assertEquals("That invoice is already paid.", c.state.value.saveError)

            c.save()
            advanceUntilIdle()
            assertEquals(listOf("upd_1790000000000_k1", "upd_1790000000000_k1"), keys)
            assertNull(c.state.value.dialogPaymentId)
        }

    @Test
    fun `editing any field after a failure drops the key`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        val keys = mutableListOf<String>()
        coEvery { repo.resolveUnappliedPayment(any(), any(), any(), any(), any(), capture(keys)) } returns
            Result.failure(RuntimeException("nope"))
        c.fill()
        c.save(); advanceUntilIdle()
        c.setApply("14.00")
        assertNull(c.pendingKey)
        assertNull(c.state.value.saveError)
        c.save(); advanceUntilIdle()
        c.setReason("Overpaid twice")
        c.save(); advanceUntilIdle()
        c.setApplyInvoice("")
        c.setApply("")
        c.save(); advanceUntilIdle()
        assertEquals(
            listOf("upd_1790000000000_k1", "upd_1790000000000_k2", "upd_1790000000000_k3", "upd_1790000000000_k4"),
            keys,
        )
    }

    @Test
    fun `busy while saving - a second press, a dismiss and edits are all refused`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        val gate = CompletableDeferred<Result<ResolveUnappliedPaymentResult>>()
        coEvery { repo.resolveUnappliedPayment(any(), any(), any(), any(), any(), any()) } coAnswers { gate.await() }
        c.fill()
        c.save()
        advanceUntilIdle()
        assertTrue(c.state.value.busy)

        c.save(); c.dismiss(); c.setCredit("1"); c.open("evt_1")
        assertEquals("evt_1", c.state.value.dialogPaymentId)
        assertEquals("10.00", c.state.value.creditText)
        assertEquals("upd_1790000000000_k1", c.pendingKey)

        gate.complete(Result.success(resolved()))
        advanceUntilIdle()
        assertFalse(c.state.value.busy)
        coVerify(exactly = 1) { repo.resolveUnappliedPayment(any(), any(), any(), any(), any(), any()) }
    }
}
