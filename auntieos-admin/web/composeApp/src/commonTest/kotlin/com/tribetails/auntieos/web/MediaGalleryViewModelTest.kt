package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.screens.media.MediaGalleryViewModel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class MediaGalleryViewModelTest {

    private fun media(id: String, entityId: String = "kf-1", entityType: String = "kinfolk") =
        MediaFile(_id = id, entityId = entityId, entityType = entityType, storageUrl = "https://example.com/$id")

    @Test
    fun initial_state_is_loading() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)

        val state = vm.uiState.first()
        assertTrue(state.isLoading)
        assertTrue(state.items.isEmpty())
        assertNull(state.error)
    }

    @Test
    fun media_items_populate_after_data_emission() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)
        val items = listOf(media("m1"), media("m2"))

        ds.emitMedia(FirestoreResult.Data(items))

        val state = vm.uiState.first { !it.isLoading }
        assertEquals(2, state.items.size)
        assertEquals("m1", state.items[0]._id)
        assertNull(state.error)
    }

    @Test
    fun empty_media_list_shows_empty_state() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)

        ds.emitMedia(FirestoreResult.Data(emptyList()))

        val state = vm.uiState.first { !it.isLoading }
        assertTrue(state.items.isEmpty())
        assertNull(state.error)
        assertFalse(state.isLoading)
    }

    @Test
    fun load_error_surfaces_error_message() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)

        ds.emitMedia(FirestoreResult.Error("firestore unavailable"))

        val state = vm.uiState.first { it.error != null }
        assertNotNull(state.error)
        assertTrue(state.error!!.contains("firestore unavailable"))
    }

    @Test
    fun upload_success_adds_item_to_stream() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)
        ds.emitMedia(FirestoreResult.Data(emptyList()))
        val state0 = vm.uiState.first { !it.isLoading }
        assertTrue(state0.items.isEmpty())

        vm.upload(byteArrayOf(1, 2, 3), "image/jpeg")

        val state = vm.uiState.first { !it.isUploading && it.items.isNotEmpty() }
        assertEquals(1, state.items.size)
        assertNull(state.error)
    }

    @Test
    fun upload_failure_sets_error_state() = runTest {
        val ds = FakeAuntieDataSource(uploadShouldFail = true)
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)
        ds.emitMedia(FirestoreResult.Data(emptyList()))
        vm.uiState.first { !it.isLoading }

        vm.upload(byteArrayOf(1, 2, 3), "image/jpeg")

        val state = vm.uiState.first { !it.isUploading }
        assertNotNull(state.error)
    }

    @Test
    fun deleteMedia_success_removes_item() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)
        val items = listOf(media("m1"), media("m2"))
        ds.emitMedia(FirestoreResult.Data(items))
        vm.uiState.first { !it.isLoading }

        vm.deleteMedia(items[0])

        val state = vm.uiState.first { s -> s.items.none { it._id == "m1" } }
        assertEquals(1, state.items.size)
        assertEquals("m2", state.items[0]._id)
        assertNull(state.error)
    }

    /**
     * #577: the scope cross-check the `deleteMediaFile` callable applies must be
     * the ROW's `entityId`, never the VM's route-derived one. Pinned with a row
     * whose entityId deliberately differs from the screen's: if this VM ever goes
     * back to passing its own constructor arg, this assertion catches it.
     */
    @Test
    fun deleteMedia_sends_the_rows_own_entityId_as_the_scope_cross_check() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = MediaGalleryViewModel(entityId = "route-kf", entityType = "kinfolk", dataSource = ds)
        val row = media("m1", entityId = "row-kf")
        ds.emitMedia(FirestoreResult.Data(listOf(row)))
        vm.uiState.first { !it.isLoading }

        vm.deleteMedia(row)

        vm.uiState.first { s -> s.items.none { it._id == "m1" } }
        assertEquals("m1" to "row-kf", ds.lastDeleteArgs)
    }

    @Test
    fun deleteMedia_failure_sets_error_state() = runTest {
        val ds = FakeAuntieDataSource(deleteShouldFail = true)
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)
        val items = listOf(media("m1"))
        ds.emitMedia(FirestoreResult.Data(items))
        vm.uiState.first { !it.isLoading }

        vm.deleteMedia(items[0])

        val state = vm.uiState.first { it.error != null }
        assertNotNull(state.error)
        assertEquals(1, state.items.size)
    }

    @Test
    fun setProfilePhoto_success_marks_exactly_one_profile_and_clears_error() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)
        val items = listOf(
            media("m1").copy(isProfilePhoto = true),
            media("m2"),
        )
        ds.emitMedia(FirestoreResult.Data(items))
        vm.uiState.first { !it.isLoading }

        vm.setProfilePhoto("m2")

        val state = vm.uiState.first { s -> s.items.any { it._id == "m2" && it.isProfilePhoto } }
        assertEquals(1, state.items.count { it.isProfilePhoto })
        assertTrue(state.items.first { it._id == "m2" }.isProfilePhoto)
        assertTrue(!state.items.first { it._id == "m1" }.isProfilePhoto)
        assertNull(state.error)
        assertEquals(Triple("m2", "kinfolk", "kf-1"), ds.lastSetProfileCall)
    }

    @Test
    fun setProfilePhoto_failure_surfaces_error_loud() = runTest {
        val ds = FakeAuntieDataSource()
        ds.setProfileShouldFail = true
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)
        ds.emitMedia(FirestoreResult.Data(listOf(media("m1"))))
        vm.uiState.first { !it.isLoading }

        vm.setProfilePhoto("m1")

        val state = vm.uiState.first { it.error != null }
        assertNotNull(state.error)
        assertTrue(state.error!!.contains("set profile failed"))
    }

    // ---- Slice 9: profile badge + caption meta pass-through (spec 28 items 2/3) ----
    // The gallery cell renders the "Profile" badge off MediaFile.isProfilePhoto and
    // the caption meta off uploadedAt/uploadedBy. These assert the stream carries
    // those fields intact into uiState.items so the badge/meta have real data.

    @Test
    fun profilePhoto_flag_and_caption_meta_survive_into_uiState() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)
        val item = media("m1").copy(
            isProfilePhoto = true,
            uploadedAt = "2026-05-27T09:41:00Z",
            uploadedBy = "jo@tribetails.com",
        )
        ds.emitMedia(FirestoreResult.Data(listOf(item)))

        val state = vm.uiState.first { !it.isLoading && it.items.isNotEmpty() }
        val streamed = state.items.first { it._id == "m1" }
        assertTrue(streamed.isProfilePhoto)
        assertEquals("2026-05-27T09:41:00Z", streamed.uploadedAt)
        assertEquals("jo@tribetails.com", streamed.uploadedBy)
        assertNull(state.error)
    }

    @Test
    fun nonProfile_item_keeps_flag_false_into_uiState() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)
        val item = media("m2").copy(isProfilePhoto = false, uploadedAt = "2026-05-27", uploadedBy = "auntie")
        ds.emitMedia(FirestoreResult.Data(listOf(item)))

        val state = vm.uiState.first { !it.isLoading && it.items.isNotEmpty() }
        val streamed = state.items.first { it._id == "m2" }
        assertTrue(!streamed.isProfilePhoto)
        // Placeholder "auntie" author is preserved on the model; the meta-line helper
        // (unit-tested) is what drops it at render time, not the stream.
        assertEquals("auntie", streamed.uploadedBy)
    }

    @Test
    fun clearError_resets_error_to_null() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = MediaGalleryViewModel(entityId = "kf-1", entityType = "kinfolk", dataSource = ds)
        ds.emitMedia(FirestoreResult.Error("oops"))
        vm.uiState.first { it.error != null }

        vm.clearError()

        assertNull(vm.uiState.value.error)
    }
}

private fun assertFalse(value: Boolean) = assertTrue(!value)
