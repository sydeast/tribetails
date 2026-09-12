package com.tribetails.auntieos.ui.media

import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * [GalleryViewModel]'s delete (#755): the global gallery's half of what the web
 * Gallery has done since #692. The three claims that matter are the ones a
 * green screen would not prove: no entity scope goes over the wire, a refusal
 * leaves the grid alone and lands in [GalleryUiState.actionError] rather than
 * [GalleryUiState.error], and a success splices exactly the one row.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class GalleryViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getAllKin() } returns Result.success(emptyList())
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun loaded(vararg rows: MediaFile): GalleryViewModel {
        coEvery { repo.getAllMedia() } returns Result.success(rows.toList())
        return GalleryViewModel(repository = repo).also { it.load() }
    }

    @Test
    fun `delete sends the file id with NO entity scope, this grid spans every household`() = runTest(testDispatcher) {
        coEvery { repo.deleteMediaFile("m1", "") } returns Result.success(Unit)
        val vm = loaded(MediaFile(id = "m1", entityId = "kf9", kinfolkId = "kf9"))

        vm.deleteMedia("m1") {}
        advanceUntilIdle()

        // The default blank entityId is what the repository OMITS from the call;
        // the row's own kinfolkId never travels.
        coVerify(exactly = 1) { repo.deleteMediaFile("m1", "") }
    }

    @Test
    fun `a resolved delete splices exactly that row out`() = runTest(testDispatcher) {
        coEvery { repo.deleteMediaFile("m1", "") } returns Result.success(Unit)
        val vm = loaded(MediaFile(id = "m1"), MediaFile(id = "m2"))
        var outcome: Boolean? = null

        vm.deleteMedia("m1") { outcome = it }
        advanceUntilIdle()

        assertEquals(true, outcome)
        assertEquals(listOf("m2"), vm.uiState.value.media.map { it.id })
        assertNull(vm.uiState.value.actionError)
        assertNull(vm.uiState.value.error)
    }

    @Test
    fun `a refused delete keeps the row and lands in actionError, never in the load error`() = runTest(testDispatcher) {
        coEvery { repo.deleteMediaFile("m1", "") } returns Result.failure(RuntimeException("Admin claim required."))
        val vm = loaded(MediaFile(id = "m1", fileType = MediaType.VIDEO), MediaFile(id = "m2"))
        var outcome: Boolean? = null

        vm.deleteMedia("m1") { outcome = it }
        advanceUntilIdle()

        assertEquals(false, outcome)
        // No optimistic splice: the document is still there, so the tile is.
        assertEquals(listOf("m1", "m2"), vm.uiState.value.media.map { it.id })
        val message = vm.uiState.value.actionError
        assertNotNull(message)
        assertTrue(message!!.contains("Admin claim required."))
        // A refused ACTION is not a failed LOAD: the grid must not blank.
        assertNull(vm.uiState.value.error)

        vm.clearActionError()
        assertNull(vm.uiState.value.actionError)
    }

    @Test
    fun `type tray labels carry the word and the count the way the mock draws them`() {
        assertEquals("All 10", galleryTypePillLabel(null, 10))
        assertEquals("Images 5", galleryTypePillLabel(MediaType.IMAGE, 5))
        assertEquals("Videos 2", galleryTypePillLabel(MediaType.VIDEO, 2))
        assertEquals("Documents 2", galleryTypePillLabel(MediaType.DOCUMENT, 2))
        assertEquals("Audio 1", galleryTypePillLabel(MediaType.AUDIO, 1))
    }

    @Test
    fun `the confirm names the kind, lowercased, as the mock and web do`() {
        assertEquals("image", galleryDeleteKindWord(MediaType.IMAGE))
        assertEquals("video", galleryDeleteKindWord(MediaType.VIDEO))
        assertEquals("document", galleryDeleteKindWord(MediaType.DOCUMENT))
        assertEquals("audio file", galleryDeleteKindWord(MediaType.AUDIO))
    }
}
