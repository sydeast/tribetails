package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsViewModelPasswordResetTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = AdminSettingsViewModel(repository = mockRepo)

    @Test
    fun `sendPasswordResetEmail flips passwordResetSent on success`() = runTest(testDispatcher) {
        coEvery { mockRepo.sendPasswordReset("admin@example.com") } returns Result.success(Unit)
        val vm = buildViewModel()

        vm.sendPasswordResetEmail("admin@example.com")
        advanceUntilIdle()

        coVerify(exactly = 1) { mockRepo.sendPasswordReset("admin@example.com") }
        val state = vm.uiState.value
        assertTrue("passwordResetSent must be true on success", state.passwordResetSent)
        assertFalse("isSendingPasswordReset must be false after completion", state.isSendingPasswordReset)
        assertNull(state.error)
    }

    @Test
    fun `sendPasswordResetEmail sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.sendPasswordReset(any()) } returns
            Result.failure(RuntimeException("network down"))
        val vm = buildViewModel()

        vm.sendPasswordResetEmail("admin@example.com")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.passwordResetSent)
        assertFalse(state.isSendingPasswordReset)
        assertNotNull(state.error)
        assertTrue(state.error!!.contains("network down"))
    }

    @Test
    fun `sendPasswordResetEmail rejects implausible email without calling repo`() =
        runTest(testDispatcher) {
            val vm = buildViewModel()

            vm.sendPasswordResetEmail("garbage")
            advanceUntilIdle()

            coVerify(exactly = 0) { mockRepo.sendPasswordReset(any()) }
            assertNotNull(vm.uiState.value.error)
        }

    @Test
    fun `clearPasswordResetSent resets flag to false`() = runTest(testDispatcher) {
        coEvery { mockRepo.sendPasswordReset(any()) } returns Result.success(Unit)
        val vm = buildViewModel()
        vm.sendPasswordResetEmail("admin@example.com")
        advanceUntilIdle()
        assertTrue("precondition: flag must be true", vm.uiState.value.passwordResetSent)

        vm.clearPasswordResetSent()

        assertFalse(vm.uiState.value.passwordResetSent)
    }
}
