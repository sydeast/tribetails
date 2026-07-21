package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.CapturingSlot
import io.mockk.coEvery
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
import org.junit.Before
import org.junit.Test

/**
 * Regression guard for the cross-platform photo-wipe bug: saveKinfolkChanges /
 * saveKinChanges rebuild the entity from scratch and persist via .set() (full
 * overwrite). If the rebuild drops profilePictureUrl, an unrelated edit wipes a
 * photo that was uploaded on web/android. These tests pin the field through save.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelPhotoTest {

    private lateinit var viewModel: DirectoryViewModel
    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val testDispatcher = UnconfinedTestDispatcher()

    private val kinfolkWithPhoto = Kinfolk(
        id = "kf1",
        firstName = "John",
        lastName = "Doe",
        phoneNumber = "555-123-4567",
        status = "active",
        profilePictureUrl = "https://cdn.example.com/kf1.jpg",
    )
    private val kinWithPhoto = Kin(
        id = "k1",
        kinfolkId = "kf1",
        name = "Buddy",
        species = "Dog",
        profilePictureUrl = "https://cdn.example.com/k1.jpg",
    )

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        coEvery { repository.getKinfolk() } returns Result.success(listOf(kinfolkWithPhoto))
        coEvery { repository.getAllKin() } returns Result.success(listOf(kinWithPhoto))
        coEvery { repository.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { repository.getKin("kf1") } returns Result.success(listOf(kinWithPhoto))
        coEvery { repository.getDossier(any()) } returns Result.success(null)
        coEvery { repository.getAllKinCareReports() } returns Result.success(emptyList())
        coEvery { repository.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repository.getInvoicesForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repository.get411ForKin(any()) } returns Result.failure(NoSuchElementException("none"))
        // Phase 2: loadProfile now reads HouseholdData for the dossier migration box.
        coEvery { repository.getHouseholdData(any()) } returns Result.success(null)
        viewModel = DirectoryViewModel(repository)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `saveKinfolkChanges preserves profilePictureUrl`() = runTest(testDispatcher) {
        advanceUntilIdle()
        val captured: CapturingSlot<Kinfolk> = slot()
        coEvery { repository.updateKinfolk(capture(captured)) } returns Result.success(Unit)

        viewModel.loadKinfolkForEdit("kf1")
        advanceUntilIdle()
        viewModel.saveKinfolkChanges()
        advanceUntilIdle()

        assertEquals("https://cdn.example.com/kf1.jpg", captured.captured.profilePictureUrl)
    }

    @Test
    fun `saveKinChanges preserves profilePictureUrl`() = runTest(testDispatcher) {
        advanceUntilIdle()
        val captured: CapturingSlot<Kin> = slot()
        coEvery { repository.updateKin(capture(captured)) } returns Result.success(Unit)

        viewModel.loadProfile("kf1")
        advanceUntilIdle()
        viewModel.loadKinForEdit("k1")
        advanceUntilIdle()
        viewModel.saveKinChanges()
        advanceUntilIdle()

        assertEquals("https://cdn.example.com/k1.jpg", captured.captured.profilePictureUrl)
    }
}
