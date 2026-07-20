package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Integration tests for credential change in AdminSettingsViewModel (spec 29 item
 * 15.4): happy path sets a confirmation message, repo failure surfaces a fail-loud
 * error, and client-side validation blocks the call entirely (negative path).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsCredentialTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private lateinit var vm: AdminSettingsViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = mockk()
        vm = AdminSettingsViewModel(repo)
    }

    @After
    fun tearDown() { Dispatchers.resetMain() }

    @Test
    fun `change password happy path sets confirmation, no error`() = runTest {
        coEvery { repo.updateLoginPassword("old", "newpass1") } returns Result.success(Unit)
        vm.changeLoginPassword("old", "newpass1", "newpass1")
        coVerify { repo.updateLoginPassword("old", "newpass1") }
        assertEquals("Password updated.", vm.uiState.value.credentialMessage)
        assertNull(vm.uiState.value.error)
    }

    @Test
    fun `change password repo failure surfaces fail-loud error`() = runTest {
        coEvery { repo.updateLoginPassword(any(), any()) } returns Result.failure(Exception("backend boom"))
        vm.changeLoginPassword("old", "newpass1", "newpass1")
        val err = vm.uiState.value.error
        assertTrue("got: $err", err != null && err.contains("backend boom"))
    }

    @Test
    fun `password mismatch is blocked before any repo call`() = runTest {
        vm.changeLoginPassword("old", "newpass1", "different")
        coVerify(exactly = 0) { repo.updateLoginPassword(any(), any()) }
        assertTrue(vm.uiState.value.error!!.contains("don't match"))
    }

    @Test
    fun `short password is blocked before any repo call`() = runTest {
        vm.changeLoginPassword("old", "123", "123")
        coVerify(exactly = 0) { repo.updateLoginPassword(any(), any()) }
        assertTrue(vm.uiState.value.error!!.contains("6 characters"))
    }

    @Test
    fun `change email happy path sets verification message`() = runTest {
        coEvery { repo.updateLoginEmail("pw", "new@x.com") } returns Result.success(Unit)
        vm.changeLoginEmail("pw", "new@x.com")
        coVerify { repo.updateLoginEmail("pw", "new@x.com") }
        assertTrue(vm.uiState.value.credentialMessage!!.contains("Verification link sent"))
    }

    @Test
    fun `invalid new email blocked before repo call`() = runTest {
        vm.changeLoginEmail("pw", "not-an-email")
        coVerify(exactly = 0) { repo.updateLoginEmail(any(), any()) }
        assertTrue(vm.uiState.value.error!!.contains("valid new login email"))
    }
}
