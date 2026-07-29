package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelExtTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private val mockInvoiceRepo = mockk<InvoiceRepository>(relaxed = true)
    private val mockKinCareRepo = mockk<KinCareRepository>(relaxed = true)

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        coEvery { mockRepo.getKinfolk() } returns Result.success(TestFixtures.allKinfolk)
        coEvery { mockRepo.getAllKin() } returns Result.success(emptyList<Kin>())
        coEvery { mockKinCareRepo.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { mockRepo.logActivity(any()) } returns Result.success(Unit)
        every { mockRepo.observeVetClinics() } returns emptyFlow()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = DirectoryViewModel(repository = mockRepo, invoiceRepository = mockInvoiceRepo, kinCareRepository = mockKinCareRepo)

    @Test
    fun `loadDirectory sets error when repository fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.getKinfolk() } returns Result.failure(RuntimeException("Network down"))

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.directoryState.value
        assertNotNull(state.error)
        assertTrue(state.error!!.isNotBlank())
    }

    @Test
    fun `empty search with All filter returns all kinfolk`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.setStatusFilter("All")
        vm.search("")
        advanceUntilIdle()

        assertEquals(2, vm.directoryState.value.displayedKinfolk.size)
    }

    @Test
    fun `filter by inactive status returns only inactive kinfolk`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.setStatusFilter("inactive")
        advanceUntilIdle()

        val displayed = vm.directoryState.value.displayedKinfolk
        assertEquals(1, displayed.size)
        assertEquals("kf2", displayed[0].id)
    }

    @Test
    fun `saveKinfolk sets error when repository fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.createKinfolkComplete(any()) } returns Result.failure(RuntimeException("Write failed"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.updateFirstName("New")
        vm.updatePhoneNumber("555-9999")
        vm.saveKinfolk()
        advanceUntilIdle()

        assertNotNull(vm.addKinfolkState.value.error)
    }

    @Test
    fun `saveKinfolk sets isSuccess on repository success`() = runTest(testDispatcher) {
        coEvery { mockRepo.createKinfolkComplete(any()) } returns Result.success(TestFixtures.kinfolk1)

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.updateFirstName("New")
        vm.updatePhoneNumber("555-9999")
        vm.saveKinfolk()
        advanceUntilIdle()

        assertTrue(vm.addKinfolkState.value.isSuccess)
    }

    @Test
    fun `saveKinfolkChanges sets error when repository fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.updateKinfolk(any()) } returns Result.failure(RuntimeException("Update failed"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.loadKinfolkForEdit("kf1")
        advanceUntilIdle()

        vm.saveKinfolkChanges()
        advanceUntilIdle()

        assertNotNull(vm.editKinfolkState.value.error)
    }

    @Test
    fun `archiveKinfolk sets error when repository fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.archiveKinfolk(any(), any(), any()) } returns Result.failure(RuntimeException("Delete failed"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.loadKinfolkForEdit("kf1")
        advanceUntilIdle()

        vm.archiveKinfolk("")
        advanceUntilIdle()

        assertNotNull(vm.editKinfolkState.value.error)
    }

    @Test
    fun `archiveKinfolk sets isDeleted on success`() = runTest(testDispatcher) {
        coEvery { mockRepo.archiveKinfolk(any(), any(), any()) } returns Result.success(Unit)

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.loadKinfolkForEdit("kf1")
        advanceUntilIdle()

        vm.archiveKinfolk("")
        advanceUntilIdle()

        assertTrue(vm.editKinfolkState.value.isDeleted)
    }

    @Test
    fun `loadProfile sets error when kinfolk not found`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.loadProfile("nonexistent")
        advanceUntilIdle()

        assertNotNull(vm.profileState.value.error)
    }

    @Test
    fun `saveKin sets error when repository fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.createKin(any()) } returns Result.failure(RuntimeException("Kin save failed"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.setKinfolkForNewKin("kf1")
        vm.updateKinName("Biscuit")
        vm.saveKin()
        advanceUntilIdle()

        assertNotNull(vm.addKinState.value.error)
    }

    @Test
    fun `search with lowercase query finds kinfolk with mixed-case firstName`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.setStatusFilter("All")
        vm.search("rosa")
        advanceUntilIdle()

        val displayed = vm.directoryState.value.displayedKinfolk
        assertTrue(
            "Expected lowercase 'rosa' to match 'Rosa Parks' (case-insensitive), got $displayed",
            displayed.any { it.firstName == "Rosa" }
        )
    }

    // H-A4: saveKinfolk with blank firstName must set an error - not silently return
    @Test
    fun `saveKinfolk with blank firstName sets error not silent no-op`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        // First name is blank; phone is present
        vm.updateFirstName("")
        vm.updatePhoneNumber("555-1111")
        vm.saveKinfolk()
        advanceUntilIdle()

        assertNotNull(
            "saveKinfolk() must set an error when firstName is blank - silent return is a bug",
            vm.addKinfolkState.value.error
        )
    }

    @Test
    fun `loadKinForEdit sets error when kin not in profile`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.loadKinForEdit("nonexistent-kin")
        advanceUntilIdle()

        assertNotNull(vm.editKinState.value.error)
    }
}
