package com.tribetails.auntieos.ui.media

import com.tribetails.auntieos.data.model.MediaAlbum
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType
import com.tribetails.auntieos.data.repository.AuntieRepository
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MediaGalleryViewModelTest {

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

    private fun buildViewModel() = MediaGalleryViewModel(repository = mockRepo)

    @Test
    fun `loadMedia populates mediaFiles and albums on success`() = runTest(testDispatcher) {
        val file = MediaFile(id = "m1", entityId = "ses1", fileType = MediaType.IMAGE)
        val album = MediaAlbum(id = "a1", entityId = "ses1")
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(listOf(file))
        coEvery { mockRepo.getMediaAlbums(any(), any()) } returns Result.success(listOf(album))

        val vm = buildViewModel()
        vm.loadMedia("ses1", MediaEntityType.VISIT_LOG)
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertEquals(1, state.mediaFiles.size)
        assertEquals(1, state.albums.size)
        assertNull(state.error)
    }

    @Test
    fun `loadMedia sets error when getMediaFiles fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.failure(RuntimeException("Load failed"))
        coEvery { mockRepo.getMediaAlbums(any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.loadMedia("ses1", MediaEntityType.VISIT_LOG)
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
        assertFalse(vm.uiState.value.isLoading)
    }

    @Test
    fun `loadMedia sets error when getMediaAlbums fails but still loads files`() = runTest(testDispatcher) {
        val file = MediaFile(id = "m1", entityId = "ses1", fileType = MediaType.IMAGE)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(listOf(file))
        coEvery { mockRepo.getMediaAlbums(any(), any()) } returns Result.failure(RuntimeException("Albums failed"))

        val vm = buildViewModel()
        vm.loadMedia("ses1", MediaEntityType.VISIT_LOG)
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertEquals(1, state.mediaFiles.size)
        assertNotNull(state.error)
    }

    @Test
    fun `initial state has isLoading true`() {
        val vm = buildViewModel()
        assertTrue(vm.uiState.value.isLoading)
    }

    @Test
    fun `setProfilePhoto success reloads media with the chosen photo flagged`() = runTest(testDispatcher) {
        val chosen = MediaFile(
            id = "m2", entityId = "kf1", entityType = MediaEntityType.KINFOLK.name, fileType = MediaType.IMAGE,
        )
        // After the callable flips the flag, the reload returns m2 as the profile.
        coEvery { mockRepo.setMediaProfilePhoto("m2", MediaEntityType.KINFOLK, "kf1") } returns Result.success(Unit)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(
            listOf(chosen.copy(isProfilePhoto = true)),
        )
        coEvery { mockRepo.getMediaAlbums(any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.setProfilePhoto(chosen)
        advanceUntilIdle()

        val state = vm.uiState.value
        assertNull(state.error)
        assertEquals(1, state.mediaFiles.count { it.isProfilePhoto })
        assertTrue(state.mediaFiles.first { it.id == "m2" }.isProfilePhoto)
    }

    @Test
    fun `setProfilePhoto failure surfaces error loud and does not reload`() = runTest(testDispatcher) {
        val chosen = MediaFile(
            id = "m1", entityId = "kf1", entityType = MediaEntityType.KINFOLK.name, fileType = MediaType.IMAGE,
        )
        coEvery { mockRepo.setMediaProfilePhoto(any(), any(), any()) } returns
            Result.failure(RuntimeException("permission-denied"))

        val vm = buildViewModel()
        vm.setProfilePhoto(chosen)
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
        assertTrue(vm.uiState.value.error!!.contains("permission-denied"))
    }
}
