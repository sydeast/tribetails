package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.ChainVerifyResult
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import io.mockk.coEvery
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Slice 9 integration test for the Activity-log chain-verify path
 * (AdminDataViewModel.verifyChain, spec 22 item 2). Drives the real verdict mapping
 * through a mockk repository and asserts a passing verify -> Done(ok), an in-band
 * anomaly -> Done(!ok) carrying the code, and a callable failure -> Error(message).
 * The chainVerdictLine that renders these is unit-tested in ChainVerdictLineTest.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminDataViewModelChainVerifyTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm() = AdminDataViewModel(repository = repo, invoiceRepository = mockk(relaxed = true), kinCareRepository = mockk(relaxed = true))

    @Test
    fun `verifyChain success maps to Done with passing verdict`() = runTest(testDispatcher) {
        val result = ChainVerifyResult(ok = true, scanned = 16, firstSeq = 1, lastSeq = 16, unchainedCount = 0, anomalyCode = null)
        coEvery { repo.verifyActivityLogChain() } returns Result.success(result)

        val vm = vm()
        vm.verifyChain()
        advanceUntilIdle()

        val state = vm.chainVerify.value
        assertTrue(state is ChainVerifyUiState.Done)
        assertTrue((state as ChainVerifyUiState.Done).result.ok)
        assertEquals(16, state.result.scanned)
    }

    @Test
    fun `verifyChain in-band anomaly maps to Done with broken verdict`() = runTest(testDispatcher) {
        val result = ChainVerifyResult(
            ok = false, scanned = 10, firstSeq = 1, lastSeq = 10, unchainedCount = 0,
            anomalyCode = "entry_hash_mismatch", anomalySeq = 7,
        )
        coEvery { repo.verifyActivityLogChain() } returns Result.success(result)

        val vm = vm()
        vm.verifyChain()
        advanceUntilIdle()

        val state = vm.chainVerify.value
        assertTrue(state is ChainVerifyUiState.Done)
        val done = state as ChainVerifyUiState.Done
        assertTrue(!done.result.ok)
        assertEquals("entry_hash_mismatch", done.result.anomalyCode)
        assertEquals(7, done.result.anomalySeq)
    }

    @Test
    fun `verifyChain failure maps to Error and preserves message`() = runTest(testDispatcher) {
        coEvery { repo.verifyActivityLogChain() } returns Result.failure(RuntimeException("permission-denied"))

        val vm = vm()
        vm.verifyChain()
        advanceUntilIdle()

        val state = vm.chainVerify.value
        assertTrue(state is ChainVerifyUiState.Error)
        assertEquals("permission-denied", (state as ChainVerifyUiState.Error).message)
    }

    @Test
    fun `verifyChain failure with null message falls back to a non-blank error`() = runTest(testDispatcher) {
        coEvery { repo.verifyActivityLogChain() } returns Result.failure(RuntimeException())

        val vm = vm()
        vm.verifyChain()
        advanceUntilIdle()

        val state = vm.chainVerify.value
        assertTrue(state is ChainVerifyUiState.Error)
        assertTrue((state as ChainVerifyUiState.Error).message.isNotBlank())
    }
}
