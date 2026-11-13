package com.tribetails.auntieos.ui.invoices

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.contracts.ApplyAccountCreditResult
import com.tribetails.auntieos.data.contracts.GetAccountCreditHistoryResult
import com.tribetails.auntieos.data.repository.InvoiceRepository
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
 * #1872 (operator ruling 2026-11-11): account credit goes onto an invoice only
 * as an amount the admin types and confirms. This is that box on Android admin:
 * what it refuses before any call, what it sends, how it waits, and the one key
 * per submission that makes a second press land on the same payment.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InvoiceApplyCreditControllerTest {

    private fun history(balance: Long) = GetAccountCreditHistoryResult(true, "fam1", balance, emptyList(), emptyList())

    private fun applied(applied: Long = 2500L, due: Long = 7500L, balance: Long = 9500L) =
        ApplyAccountCreditResult(true, "inv1", "acr_1790000000000_k1", applied, due, balance, false)

    private var minted = 0
    private val mint = { minted += 1; "acr_1790000000000_k$minted" }

    private val notices = mutableListOf<String>()

    private fun setup(scope: TestScope, repo: InvoiceRepository, balance: Long = 12000L): InvoiceApplyCreditController {
        coEvery { repo.getAccountCreditHistory("fam1") } returns Result.success(history(balance))
        val c = InvoiceApplyCreditController(repo, scope, mint) { _, sentence -> notices += sentence }
        c.load("inv1", "fam1")
        scope.advanceUntilIdle()
        return c
    }

    @Test
    fun `loads the household's available credit`() = runTest(StandardTestDispatcher()) {
        val c = setup(this, mockk())
        assertEquals(12000L, c.state.value.availableCents)
        assertTrue(c.state.value.visible)
        assertFalse(c.state.value.loading)
    }

    @Test
    fun `permission-denied hides the box, because an Auntie never sees money`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val denied = mockk<FirebaseFunctionsException>()
        every { denied.code } returns FirebaseFunctionsException.Code.PERMISSION_DENIED
        coEvery { repo.getAccountCreditHistory("fam1") } returns Result.failure(denied)
        val c = InvoiceApplyCreditController(repo, this, mint)
        c.load("inv1", "fam1")
        advanceUntilIdle()
        assertFalse(c.state.value.visible)
    }

    @Test
    fun `any other read failure keeps the box and says so, and Try again reads it`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        coEvery { repo.getAccountCreditHistory("fam1") } returns Result.failure(RuntimeException("offline"))
        val c = InvoiceApplyCreditController(repo, this, mint)
        c.load("inv1", "fam1")
        advanceUntilIdle()
        assertTrue(c.state.value.visible)
        assertEquals("Couldn't load account credit.", c.state.value.loadError)

        coEvery { repo.getAccountCreditHistory("fam1") } returns Result.success(history(500L))
        c.retryLoad()
        advanceUntilIdle()
        assertNull(c.state.value.loadError)
        assertEquals(500L, c.state.value.availableCents)
    }

    @Test
    fun `an invoice with no household shows no box and reads nothing`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = InvoiceApplyCreditController(repo, this, mint)
        c.load("inv1", "")
        advanceUntilIdle()
        assertFalse(c.state.value.visible)
        coVerify(exactly = 0) { repo.getAccountCreditHistory(any()) }
    }

    @Test
    fun `every refusal sits on the field and never reaches the server`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        val cases = listOf(
            "" to "Enter an amount in dollars, like 25.00.",
            "abc" to "Enter an amount in dollars, like 25.00.",
            "-5" to "Enter an amount in dollars, like 25.00.",
            "0" to "Enter an amount above \$0.00.",
            "120.01" to "This household has \$120.00 of account credit. Enter that much or less.",
            "100.01" to "This invoice has \$100.00 left to pay. Enter that much or less.",
        )
        for ((typed, words) in cases) {
            c.setAmount(typed)
            c.review(10000L)
            assertEquals(typed, words, c.state.value.fieldError)
            assertEquals(typed, ApplyCreditStep.Edit, c.state.value.step)
            // Confirm does nothing while the form has not passed.
            c.confirm("1026")
        }
        advanceUntilIdle()
        coVerify(exactly = 0) { repo.applyAccountCredit(any(), any(), any()) }
        // Typing again clears the refusal.
        c.setAmount("1")
        assertNull(c.state.value.fieldError)
    }

    @Test
    fun `asks first, and sends nothing until she agrees`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        c.setAmount("25")
        c.review(10000L)
        assertEquals(ApplyCreditStep.Confirm, c.state.value.step)
        assertEquals(2500L, c.state.value.pendingAmountCents)
        c.back()
        assertEquals(ApplyCreditStep.Edit, c.state.value.step)
        assertEquals("25", c.state.value.amountText)
        advanceUntilIdle()
        coVerify(exactly = 0) { repo.applyAccountCredit(any(), any(), any()) }
    }

    @Test
    fun `sends the amount in cents with a key, then says what the server did and reads the balance again`() =
        runTest(StandardTestDispatcher()) {
            val repo = mockk<InvoiceRepository>()
            val c = setup(this, repo)
            coEvery { repo.applyAccountCredit("inv1", 2500L, "acr_1790000000000_k1") } returns Result.success(applied())
            coEvery { repo.getAccountCreditHistory("fam1") } returns Result.success(history(9500L))

            c.setAmount("25.00")
            c.review(10000L)
            c.confirm("1026")
            advanceUntilIdle()

            coVerify(exactly = 1) { repo.applyAccountCredit("inv1", 2500L, "acr_1790000000000_k1") }
            assertEquals(
                listOf(
                    "Applied \$25.00 of account credit to invoice 1026. \$75.00 is left to pay. " +
                        "The household has \$95.00 of credit left.",
                ),
                notices,
            )
            val s = c.state.value
            assertFalse(s.busy)
            assertEquals(ApplyCreditStep.Edit, s.step)
            assertEquals("", s.amountText)
            assertEquals(9500L, s.availableCents)
            assertNull(c.pendingKey)
            // Once on open, once after the credit moved.
            coVerify(exactly = 2) { repo.getAccountCreditHistory("fam1") }
        }

    @Test
    fun `the wait is visible, and a second press while it is in flight calls once`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        val gate = CompletableDeferred<Result<ApplyAccountCreditResult>>()
        coEvery { repo.applyAccountCredit(any(), any(), any()) } coAnswers { gate.await() }

        c.setAmount("25")
        c.review(10000L)
        c.confirm("1026")
        testScheduler.runCurrent()
        assertTrue(c.state.value.busy)

        // None of these may do anything while the call is in flight.
        c.confirm("1026")
        c.back()
        c.setAmount("99")
        testScheduler.runCurrent()
        assertEquals(ApplyCreditStep.Confirm, c.state.value.step)
        assertEquals("25", c.state.value.amountText)

        gate.complete(Result.success(applied()))
        advanceUntilIdle()
        assertFalse(c.state.value.busy)
        coVerify(exactly = 1) { repo.applyAccountCredit(any(), any(), any()) }
    }

    @Test
    fun `a server refusal is shown in its own words under the field, and the form comes back`() =
        runTest(StandardTestDispatcher()) {
            val repo = mockk<InvoiceRepository>()
            val c = setup(this, repo)
            coEvery { repo.applyAccountCredit(any(), any(), any()) } returns
                Result.failure(RuntimeException("This invoice is already paid, so it takes no credit."))

            c.setAmount("25")
            c.review(10000L)
            c.confirm("1026")
            advanceUntilIdle()

            val s = c.state.value
            assertEquals("This invoice is already paid, so it takes no credit.", s.fieldError)
            assertEquals(ApplyCreditStep.Edit, s.step)
            assertEquals("25", s.amountText)
            assertFalse(s.busy)
            assertTrue(notices.isEmpty())
            // The balance is read again: what she holds or owes may have moved.
            coVerify(exactly = 2) { repo.getAccountCreditHistory("fam1") }
        }

    @Test
    fun `a failure with no words still says something plain`() {
        assertEquals("Couldn't apply credit. Try again.", applyCreditErrorText(RuntimeException()))
        assertEquals("Couldn't apply credit. Try again.", applyCreditErrorText(RuntimeException("  ")))
    }

    @Test
    fun `pressing again after a lost reply sends the SAME key, so the amount lands once`() =
        runTest(StandardTestDispatcher()) {
            val repo = mockk<InvoiceRepository>()
            val c = setup(this, repo)
            val keys = mutableListOf<String>()
            coEvery { repo.applyAccountCredit(any(), any(), capture(keys)) } returnsMany listOf(
                Result.failure(RuntimeException("internal")),
                Result.success(applied()),
            )

            c.setAmount("25")
            c.review(10000L)
            c.confirm("1026")
            advanceUntilIdle()
            c.review(10000L)
            c.confirm("1026")
            advanceUntilIdle()

            assertEquals(listOf("acr_1790000000000_k1", "acr_1790000000000_k1"), keys)
        }

    @Test
    fun `changing the amount makes it a different submission with a new key`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        val keys = mutableListOf<String>()
        val amounts = mutableListOf<Long>()
        coEvery { repo.applyAccountCredit(any(), capture(amounts), capture(keys)) } returnsMany listOf(
            Result.failure(RuntimeException("internal")),
            Result.success(applied(applied = 1100L, due = 8900L, balance = 10900L)),
        )

        c.setAmount("25")
        c.review(10000L)
        c.confirm("1026")
        advanceUntilIdle()
        c.setAmount("11")
        c.review(10000L)
        c.confirm("1026")
        advanceUntilIdle()

        assertEquals(listOf("acr_1790000000000_k1", "acr_1790000000000_k2"), keys)
        assertEquals(listOf(2500L, 1100L), amounts)
    }

    @Test
    fun `Review and send says only what it does`() {
        assertEquals(
            "This sends the draft to the household and marks the invoice open. A draft missing its " +
                "total, household, or invoice number is rejected rather than sent.",
            REVIEW_AND_SEND_CONFIRM_COPY,
        )
        assertFalse(Regex("credit|paid|payment", RegexOption.IGNORE_CASE).containsMatchIn(REVIEW_AND_SEND_CONFIRM_COPY))
    }

    @Test
    fun `a leftover held as credit is not promised to any invoice`() {
        val held = recordPaymentBalanceCopy(2500L, autoApply = true)
        assertEquals(
            "Unapplied balance \$25.00, and it will be held as this household's account credit " +
                "until you apply an amount to an invoice.",
            held,
        )
        for (copy in listOf(held, recordPaymentBalanceCopy(2500L, autoApply = false), recordPaymentCreditNote(2500L))) {
            assertFalse(copy, Regex("automatically|next invoice|auto-apply", RegexOption.IGNORE_CASE).containsMatchIn(copy))
        }
    }
}
