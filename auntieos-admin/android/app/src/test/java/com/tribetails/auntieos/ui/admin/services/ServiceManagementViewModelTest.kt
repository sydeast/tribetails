package com.tribetails.auntieos.ui.admin.services

import com.tribetails.auntieos.data.model.BaseService
import com.tribetails.auntieos.data.model.BusinessHours
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.SupplementalService
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.ServiceRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ServiceManagementViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        auntieRepo = mockk()
        coEvery { mockRepo.getBaseServices(any()) } returns Result.success(emptyList())
        coEvery { mockRepo.getSupplementalServices(any()) } returns Result.success(emptyList())
        coEvery { mockRepo.getSurcharges(any()) } returns Result.success(emptyList())
        coEvery { mockRepo.getDiscounts(any()) } returns Result.success(emptyList())
        coEvery { mockRepo.getPromoCodes(any()) } returns Result.success(emptyList())
        coEvery { mockRepo.getBusinessHours() } returns Result.success(emptyList())
        // Unified settings: ServiceManagementViewModel now reads/writes the
        // BusinessSettings doc via AuntieRepository.
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
        // The audit trail a successful save fires. Stubbed so the success branch
        // is reachable off-device at all.
        coEvery { auntieRepo.logActivity(any()) } returns Result.success(Unit)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() =
        ServiceManagementViewModel(serviceRepository = mockRepo, auntieRepository = auntieRepo)

    @Test
    fun `init loads all data and clears isLoading`() = runTest(testDispatcher) {
        val service = BaseService(id = "s1", title = "Dog Walk")
        coEvery { mockRepo.getBaseServices(any()) } returns Result.success(listOf(service))

        val vm = buildViewModel()
        advanceUntilIdle()

        assertFalse(vm.state.value.isLoading)
        assertEquals(1, vm.state.value.baseServices.size)
        assertNull(vm.state.value.errorMessage)
    }

    @Test
    fun `loadAllData sets errorMessage when repo throws`() = runTest(testDispatcher) {
        coEvery { mockRepo.getBaseServices(any()) } throws RuntimeException("Network timeout")

        val vm = buildViewModel()
        advanceUntilIdle()

        assertNotNull(vm.state.value.errorMessage)
        assertFalse(vm.state.value.isLoading)
    }

    @Test
    fun `selectTab updates selectedTab`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.selectTab(ServiceTab.PRICING)
        assertEquals(ServiceTab.PRICING, vm.state.value.selectedTab)
    }

    @Test
    fun `createBaseService sets errorMessage on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.createBaseService(any()) } returns Result.failure<String>(RuntimeException("Create failed"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.createBaseService(BaseService(title = "New Walk"))
        advanceUntilIdle()

        assertNotNull(vm.state.value.errorMessage)
    }

    @Test
    fun `createBaseService reloads base services on success`() = runTest(testDispatcher) {
        // Blank id: create mints the id, and the repository now REFUSES a
        // non-blank one rather than bare-setting the whole model over an
        // existing document. See ServiceRepository.createBaseService.
        coEvery { mockRepo.createBaseService(any()) } returns Result.success("s1")
        coEvery { mockRepo.getBaseServices(any()) } returns
            Result.success(listOf(BaseService(id = "s1", title = "New Walk")))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.createBaseService(BaseService(title = "New Walk"))
        advanceUntilIdle()

        assertEquals(1, vm.state.value.baseServices.size)
    }

    @Test
    fun `updateBaseService sets errorMessage on failure`() = runTest(testDispatcher) {
        val loaded = BaseService(id = "s1", title = "Dog Walk")
        coEvery { mockRepo.getBaseServices(any()) } returns Result.success(listOf(loaded))
        coEvery { mockRepo.updateBaseServiceFields(any(), any()) } returns
            Result.failure(RuntimeException("Update failed"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.updateBaseService(loaded.copy(title = "Updated"))
        advanceUntilIdle()

        assertNotNull(vm.state.value.errorMessage)
    }

    /**
     * The diff, at the ViewModel seam: only the field the operator actually
     * changed reaches the repository. The loaded row is the baseline, so the
     * `isActive` this screen read cannot ride along and undo a soft delete made
     * elsewhere since.
     */
    @Test
    fun `updateBaseService sends only the changed field`() = runTest(testDispatcher) {
        val loaded = BaseService(id = "s1", title = "Dog Walk", basePrice = 25.0, isActive = true)
        coEvery { mockRepo.getBaseServices(any()) } returns Result.success(listOf(loaded))
        val sent = slot<Map<String, Any?>>()
        coEvery { mockRepo.updateBaseServiceFields("s1", capture(sent)) } returns Result.success(Unit)

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.updateBaseService(loaded.copy(basePrice = 30.0))
        advanceUntilIdle()

        assertEquals(setOf("basePrice"), sent.captured.keys)
        assertEquals(30.0, sent.captured["basePrice"])
    }

    /**
     * A save that changed nothing could only move the stamp and fire an audit
     * entry, both claiming an edit that never happened. It must not reach
     * Firestore at all.
     */
    @Test
    fun `updateBaseService writes nothing when the operator changed nothing`() = runTest(testDispatcher) {
        val loaded = BaseService(id = "s1", title = "Dog Walk", basePrice = 25.0)
        coEvery { mockRepo.getBaseServices(any()) } returns Result.success(listOf(loaded))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.updateBaseService(loaded.copy())
        advanceUntilIdle()

        coVerify(exactly = 0) { mockRepo.updateBaseServiceFields(any(), any()) }
        assertNull(vm.state.value.errorMessage)
    }

    /**
     * No baseline means no honest diff. Falling back to a default model would
     * write ten Kotlin defaults over a real service, which is the exact
     * default-model-over-a-real-record shape PR #315 removed elsewhere.
     */
    @Test
    fun `updateBaseService refuses to save a service it never loaded`() = runTest(testDispatcher) {
        coEvery { mockRepo.getBaseServices(any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.updateBaseService(BaseService(id = "ghost", title = "Updated"))
        advanceUntilIdle()

        coVerify(exactly = 0) { mockRepo.updateBaseServiceFields(any(), any()) }
        assertNotNull(vm.state.value.errorMessage)
    }

    @Test
    fun `deleteBaseService sets errorMessage on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.deleteBaseService(any()) } returns Result.failure(RuntimeException("Delete failed"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.deleteBaseService("s1")
        advanceUntilIdle()

        assertNotNull(vm.state.value.errorMessage)
    }

    @Test
    fun `updateBusinessSettings sets errorMessage on failure`() = runTest(testDispatcher) {
        coEvery { auntieRepo.updateBusinessSettingsFields(any(), any()) } returns Result.failure(RuntimeException("Settings fail"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.updateBusinessSettings(BusinessSettings(enableConflictDetection = false))
        advanceUntilIdle()

        assertNotNull(vm.state.value.errorMessage)
    }

    @Test
    fun `updateBusinessSettings updates local state on success`() = runTest(testDispatcher) {
        coEvery { auntieRepo.updateBusinessSettingsFields(any(), any()) } returns Result.success(Unit)

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.updateBusinessSettings(BusinessSettings(enableConflictDetection = false))
        advanceUntilIdle()

        assertFalse(vm.state.value.businessSettings.enableConflictDetection)
        assertNull(vm.state.value.errorMessage)
    }

    @Test
    fun `deleteBaseService sets errorMessage when repository returns failure`() =
        runTest(testDispatcher) {
            coEvery { mockRepo.deleteBaseService("svc1") } returns
                Result.failure(RuntimeException("Service has active bookings"))

            val vm = buildViewModel()
            advanceUntilIdle()

            vm.deleteBaseService("svc1")
            advanceUntilIdle()

            assertFalse(vm.state.value.isLoading)
            assertNotNull(vm.state.value.errorMessage)
            assertTrue(vm.state.value.errorMessage!!.contains("Failed to delete service"))
        }

    @Test
    fun `clearError resets errorMessage to null`() = runTest(testDispatcher) {
        coEvery { mockRepo.deleteBaseService(any()) } returns Result.failure(RuntimeException("fail"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.deleteBaseService("s1")
        advanceUntilIdle()

        assertNotNull(vm.state.value.errorMessage)
        vm.clearError()
        assertNull(vm.state.value.errorMessage)
    }
}
