package com.tribetails.auntieos.ui.directory

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.contracts.GetAccountCreditHistoryResult
import com.tribetails.auntieos.data.contracts.GiveAccountCreditResult
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
 * Q6: the Give credit dialog on Android admin. The key is per submission: kept
 * through a failed save so the retry reuses it, fresh after a success or a
 * changed amount. The success note repeats only the server's balance.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AccountCreditControllerTest {

    private fun history(balance: Long) = GetAccountCreditHistoryResult(true, "fam1", balance, emptyList(), emptyList())
    private fun given(balance: Long) = GiveAccountCreditResult(true, "k", 2500L, balance, false)

    private var minted = 0
    private val mint = { minted += 1; "crd_1790000000000_k$minted" }

    private fun setup(scope: TestScope, repo: InvoiceRepository): AccountCreditController {
        coEvery { repo.getAccountCreditHistory("fam1") } returns Result.success(history(1200L))
        val c = AccountCreditController(repo, scope, mint)
        c.load("fam1")
        scope.advanceUntilIdle()
        return c
    }

    private fun AccountCreditController.fill(amount: String = "25.00", reason: String = "Missed visit") {
        open(); setAmount(amount); setReason(reason)
    }

    @Test
    fun `loads the history and shows it`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        assertEquals(1200L, c.state.value.history?.accountBalanceCents)
        assertTrue(c.state.value.visible)
    }

    @Test
    fun `permission-denied hides the section`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val denied = mockk<FirebaseFunctionsException>()
        every { denied.code } returns FirebaseFunctionsException.Code.PERMISSION_DENIED
        coEvery { repo.getAccountCreditHistory("fam1") } returns Result.failure(denied)
        val c = AccountCreditController(repo, this, mint)
        c.load("fam1")
        advanceUntilIdle()
        assertFalse(c.state.value.visible)
    }

    @Test
    fun `any other read failure keeps the section and says so`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        coEvery { repo.getAccountCreditHistory("fam1") } returns Result.failure(RuntimeException("offline"))
        val c = AccountCreditController(repo, this, mint)
        c.load("fam1")
        advanceUntilIdle()
        assertTrue(c.state.value.visible)
        assertEquals("Couldn't load account credit.", c.state.value.loadError)
    }

    @Test
    fun `refusals stay on the form and call nothing`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        for ((amount, reason) in listOf("" to "r", "0" to "r", "-1" to "r", "1.234" to "r", "5000.01" to "r", "25" to " ")) {
            c.fill(amount, reason)
            c.review()
            assertEquals(GiveCreditStep.Edit, c.state.value.step)
            assertTrue(c.state.value.formError != null)
        }
        assertEquals(0, minted)
        coVerify(exactly = 0) { repo.giveAccountCredit(any(), any(), any(), any()) }
    }

    @Test
    fun `review shows the confirmation with the new balance`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        c.fill()
        c.review()
        assertEquals(GiveCreditStep.Confirm, c.state.value.step)
        assertEquals(2500L, c.state.value.pendingAmountCents)
        assertEquals("Missed visit", c.state.value.pendingReason)
    }

    @Test
    fun `success closes, uses the server balance, reloads, and the next submission gets a fresh key`() =
        runTest(StandardTestDispatcher()) {
            val repo = mockk<InvoiceRepository>()
            val c = setup(this, repo)
            // The server says 9999, not the client's 1200 + 2500: the note must repeat the server.
            coEvery { repo.giveAccountCredit("fam1", 2500L, "Missed visit", any()) } returns Result.success(given(9999L))
            c.fill(); c.review(); c.confirm()
            advanceUntilIdle()

            assertEquals(GiveCreditStep.Closed, c.state.value.step)
            assertEquals("Credit given. Balance is now $99.99.", c.state.value.message)
            coVerify(exactly = 2) { repo.getAccountCreditHistory("fam1") }
            assertNull(c.pendingKey)

            c.fill(); c.review()
            assertEquals("crd_1790000000000_k2", c.pendingKey)
        }

    @Test
    fun `a failed save keeps the dialog open and the retry reuses the same key`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        val keys = mutableListOf<String>()
        coEvery { repo.giveAccountCredit(any(), any(), any(), capture(keys)) } returnsMany listOf(
            Result.failure(RuntimeException("INTERNAL")),
            Result.success(given(3700L)),
        )
        c.fill(); c.review(); c.confirm()
        advanceUntilIdle()
        assertEquals(GiveCreditStep.Confirm, c.state.value.step)
        assertEquals("Couldn't give credit: INTERNAL", c.state.value.formError)

        c.confirm()
        advanceUntilIdle()
        assertEquals(listOf("crd_1790000000000_k1", "crd_1790000000000_k1"), keys)
        assertEquals(GiveCreditStep.Closed, c.state.value.step)
    }

    @Test
    fun `changing the amount makes it a new submission with a new key`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        c.fill(); c.review()
        assertEquals("crd_1790000000000_k1", c.pendingKey)
        c.back()
        c.setAmount("30.00")
        c.review()
        assertEquals("crd_1790000000000_k2", c.pendingKey)
    }

    @Test
    fun `busy while saving - a second press, a dismiss and edits are all refused`() = runTest(StandardTestDispatcher()) {
        val repo = mockk<InvoiceRepository>()
        val c = setup(this, repo)
        val gate = CompletableDeferred<Result<GiveAccountCreditResult>>()
        coEvery { repo.giveAccountCredit(any(), any(), any(), any()) } coAnswers { gate.await() }
        c.fill(); c.review(); c.confirm()
        advanceUntilIdle()
        assertTrue(c.state.value.busy)

        c.confirm(); c.dismiss(); c.setAmount("1")
        assertEquals(GiveCreditStep.Confirm, c.state.value.step)
        assertEquals("25.00", c.state.value.amountText)

        gate.complete(Result.success(given(3700L)))
        advanceUntilIdle()
        assertFalse(c.state.value.busy)
        coVerify(exactly = 1) { repo.giveAccountCredit(any(), any(), any(), any()) }
    }
}
