package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.Draft
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.RecentComms
import com.tribetails.auntieos.domain.HouseholdTextAccount
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #2316 (operator ruling 2026-11-20): a household with no MyTribe account is
 * texted the whole message, one with an account the short line and a link.
 * The Text confirm asks the server which, for the household the send names,
 * and shows Checking until it answers and Unknown when it cannot.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CommunicateTextAccountTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private val asked = mutableListOf<String>()

    private val stored = Draft(
        id = "gd1",
        status = "pending",
        communicationType = "sms",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        generatedCopy = "Biscuit chased every leaf.",
        createdOn = "2026-11-20T22:23:00.000Z",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        asked.clear()
        repo = mockk()
        coEvery { repo.getKinfolk() } returns Result.success(TestFixtures.allKinfolk)
        coEvery { repo.recentCommsForKinfolk(any()) } returns Result.success(RecentComms())
        coEvery { repo.getHouseholdBank(any()) } returns Result.success(null)
        coEvery { repo.getDossier(any()) } returns Result.success(null)
        coEvery { repo.getKin(any()) } returns Result.success(emptyList())
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(stored)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm(answer: suspend (String) -> HouseholdTextAccount) =
        CommunicateViewModel(repo = repo, textAccountOf = { id -> asked += id; answer(id) })

    private suspend fun openTextDraft(vm: CommunicateViewModel) {
        vm.loadDraft("gd1")
    }

    @Test
    fun `the Text confirm asks about the household the send names and shows no account`() = runTest(testDispatcher) {
        val vm = vm { HouseholdTextAccount.NoAccount }
        advanceUntilIdle()
        openTextDraft(vm)
        advanceUntilIdle()
        vm.requestApprove()
        advanceUntilIdle()
        val s = vm.uiState.value
        assertTrue(s.approveConfirmOpen)
        assertEquals(listOf("kf1"), asked.distinct())
        assertEquals("kf1", s.textAccountFor)
        assertEquals(HouseholdTextAccount.NoAccount, s.textAccount)
    }

    @Test
    fun `Checking until the server answers, then the answer`() = runTest(testDispatcher) {
        val gate = CompletableDeferred<HouseholdTextAccount>()
        val vm = vm { gate.await() }
        advanceUntilIdle()
        openTextDraft(vm)
        advanceUntilIdle()
        vm.requestApprove()
        assertEquals(HouseholdTextAccount.Checking, vm.uiState.value.textAccount)
        gate.complete(HouseholdTextAccount.Account)
        advanceUntilIdle()
        assertEquals(HouseholdTextAccount.Account, vm.uiState.value.textAccount)
    }

    @Test
    fun `ERROR - a failed check is Unknown, never a guess`() = runTest(testDispatcher) {
        val vm = vm { error("unavailable") }
        advanceUntilIdle()
        vm.checkTextAccount("kf1")
        advanceUntilIdle()
        assertEquals(HouseholdTextAccount.Unknown, vm.uiState.value.textAccount)
    }

    @Test
    fun `NEGATIVE - a late answer for a household no longer chosen is dropped`() = runTest(testDispatcher) {
        val first = CompletableDeferred<HouseholdTextAccount>()
        val vm = vm { id -> if (id == "kf1") first.await() else HouseholdTextAccount.Account }
        advanceUntilIdle()
        vm.checkTextAccount("kf1")
        vm.checkTextAccount("kf2")
        advanceUntilIdle()
        first.complete(HouseholdTextAccount.NoAccount)
        advanceUntilIdle()
        assertEquals("kf2", vm.uiState.value.textAccountFor)
        assertEquals(HouseholdTextAccount.Account, vm.uiState.value.textAccount)
    }

    @Test
    fun `NEGATIVE - no household asks nothing`() = runTest(testDispatcher) {
        val vm = vm { HouseholdTextAccount.NoAccount }
        advanceUntilIdle()
        vm.checkTextAccount(" ")
        advanceUntilIdle()
        assertTrue(asked.isEmpty())
        assertEquals(HouseholdTextAccount.Checking, vm.uiState.value.textAccount)
    }

    @Test
    fun `an Email confirm does not ask`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(stored.copy(communicationType = "email", generatedTitle = "Hi"))
        val vm = vm { HouseholdTextAccount.NoAccount }
        advanceUntilIdle()
        openTextDraft(vm)
        advanceUntilIdle()
        vm.requestApprove()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.approveConfirmOpen)
        assertTrue(asked.isEmpty())
    }
}
