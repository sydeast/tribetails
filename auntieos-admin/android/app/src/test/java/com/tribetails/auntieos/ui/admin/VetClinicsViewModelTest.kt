package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.VetClinic
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
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
 * Integration tests for the Android vet-clinic CRUD. Drives the real
 * VetClinicsViewModel against a mocked AuntieRepository: stream surfacing, the
 * happy path (call reaches the repo), and the sad/error path (failure surfaces on
 * [error], fail-loud, never swallowed).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class VetClinicsViewModelTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private val clinic = VetClinic(id = "c1", name = "Creekside", phone = "555", address = "1 Ln", notes = "n")

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = mockk()
        every { repo.observeVetClinics() } returns flowOf(emptyList())
        // #6: the VM loads kinfolk vet names on init for the household-count badge.
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
    }

    @After
    fun tearDown() { Dispatchers.resetMain() }

    @Test
    fun `clinics stream surfaces repo data`() = runTest {
        every { repo.observeVetClinics() } returns flowOf(listOf(clinic))
        val vm = VetClinicsViewModel(repo)
        assertEquals(listOf(clinic), vm.clinics.value)
    }

    @Test
    fun `remove happy path hard-deletes by id and clears error`() = runTest {
        coEvery { repo.deleteVetClinic("c1") } returns Result.success(Unit)
        val vm = VetClinicsViewModel(repo)
        vm.remove("c1", "Creekside").join()
        coVerify { repo.deleteVetClinic("c1") }
        assertNull(vm.error.value)
    }

    @Test
    fun `delete failure surfaces a fail-loud error message`() = runTest {
        coEvery { repo.deleteVetClinic("c1") } returns Result.failure(Exception("permission-denied"))
        val vm = VetClinicsViewModel(repo)
        vm.remove("c1", "Creekside").join()
        val err = vm.error.value
        assertTrue("got: $err", err != null && err.contains("Creekside") && err.contains("permission-denied"))
    }

    /**
     * `add` routes through submitVetClinic, not a direct vet_clinics write, so
     * the shared bank's normalized-name dedupe applies to operator-added clinics
     * too. See the ViewModel's note.
     */
    @Test
    fun `add and save reach the repo`() = runTest {
        coEvery { repo.submitVetClinic(any()) } returns Result.success("new-id")
        coEvery { repo.updateVetClinic(any()) } returns Result.success(Unit)
        val vm = VetClinicsViewModel(repo)
        vm.add(clinic).join()
        vm.save(clinic).join()
        coVerify { repo.submitVetClinic(clinic) }
        coVerify { repo.updateVetClinic(clinic) }
        assertNull(vm.error.value)
    }

    @Test
    fun `add failure then later success clears the error`() = runTest {
        coEvery { repo.submitVetClinic(any()) } returns Result.failure(Exception("boom"))
        val vm = VetClinicsViewModel(repo)
        vm.add(clinic).join()
        assertTrue(vm.error.value != null)
        coEvery { repo.submitVetClinic(any()) } returns Result.success("ok")
        vm.add(clinic).join()
        assertNull(vm.error.value)
    }
}
