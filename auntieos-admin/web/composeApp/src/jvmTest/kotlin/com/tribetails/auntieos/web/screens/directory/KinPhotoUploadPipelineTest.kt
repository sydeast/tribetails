package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.ui.components.ToastKind
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #853: KinEditScreen's "Change photo" control (pet photos) had the same
 * defect as the Kinfolk one: it saved via `build().copy(profilePictureUrl =
 * url)`, so a photo change silently persisted every unsaved field elsewhere on
 * the form, and "Photo updated." showed even when the write failed.
 *
 * [runKinPhotoUploadPipeline], [kinWithPhoto] and [writeKinPhoto] are the fix,
 * extracted the same way `runAvatarUploadPipeline` is in SettingsScreen.kt so
 * a fake upload/write can drive every outcome without a live Cloudinary
 * upload, a real Firestore write, or a Swing file picker.
 */
class KinPhotoUploadPipelineTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun photo(url: String = "https://res.cloudinary.com/demo/image/upload/new.jpg") =
        MediaFile(_id = "media-1", storageUrl = url)

    // ---- runKinPhotoUploadPipeline: pure, fake upload/write ----

    @Test
    fun `a successful upload and write shows the photo and the success toast only after the write lands`() = runTest {
        var photoUrl: String? = null
        var toast: Pair<String, ToastKind>? = null
        val uploaded = photo()

        runKinPhotoUploadPipeline(
            previousUrl = "https://old.jpg",
            upload      = { WriteResult.Ok(uploaded) },
            write       = { url -> assertEquals(uploaded.storageUrl, url); WriteResult.Ok(Unit) },
            onPhotoUrl  = { photoUrl = it },
            onToast     = { toast = it },
        )

        assertEquals(uploaded.storageUrl, photoUrl)
        assertEquals("Photo updated." to ToastKind.Success, toast)
    }

    @Test
    fun `a failed write reverts the preview and never shows the success toast`() = runTest {
        val seen = mutableListOf<String>()
        val toasts = mutableListOf<Pair<String, ToastKind>>()
        val uploaded = photo()

        runKinPhotoUploadPipeline(
            previousUrl = "https://old.jpg",
            upload      = { WriteResult.Ok(uploaded) },
            write       = { WriteResult.Err("Not signed in") },
            onPhotoUrl  = { seen += it },
            onToast     = { toasts += it },
        )

        assertEquals(listOf(uploaded.storageUrl, "https://old.jpg"), seen)
        // Exactly one toast, and it is never the success one: a caller that
        // fired both "Photo updated." and the error would still be caught here,
        // unlike a last-write-wins single toast variable.
        // The upload landed (the file is in Gallery), so the toast says so rather
        // than implying nothing happened and inviting a duplicate retry.
        assertEquals(listOf("Photo uploaded but save failed: Not signed in" to ToastKind.Error), toasts)
        assertTrue(toasts.none { it.first == "Photo updated." }, "a failed write must never show the success toast")
    }

    @Test
    fun `a failed upload never touches the preview and shows the upload's own error`() = runTest {
        var photoUrl: String? = null
        var toast: Pair<String, ToastKind>? = null
        var writeCalled = false

        runKinPhotoUploadPipeline(
            previousUrl = "https://old.jpg",
            upload      = { WriteResult.Err("Selected media exceeds the 50MB limit") },
            write       = { writeCalled = true; WriteResult.Ok(Unit) },
            onPhotoUrl  = { photoUrl = it },
            onToast     = { toast = it },
        )

        assertNull(photoUrl)
        assertFalse(writeCalled, "a rejected upload must never reach the write")
        assertEquals("Photo upload failed: Selected media exceeds the 50MB limit" to ToastKind.Error, toast)
    }

    // ---- kinWithPhoto / writeKinPhoto: the real write, proving the shape ----

    /**
     * `updateKin` is a whole-document write (no field-level mask to assert on,
     * unlike Kinfolk's merge), so the invariant this pins is structural:
     * [kinWithPhoto] carries every field of the loaded record forward
     * unchanged except the photo. An operator's typed-but-unsaved edit (a new
     * name, say) lives solely in the screen's Compose state, which
     * [kinWithPhoto] has no access to at all - only [loadedRecord] is ever
     * read.
     */
    @Test
    fun `a photo change preserves every other field even with an unsaved draft sitting nearby`() {
        val loadedRecord = Kin(
            _id = "k1",
            kinfolkId = "kf1",
            name = "Fido",
            species = "Dog",
            breed = "Labrador",
            weight = "40",
            tags = listOf("Reactive"),
        )
        val unsavedDraft = loadedRecord.copy(name = "Fido Jr.", weight = "42")
        assertNotEquals(loadedRecord, unsavedDraft, "sanity: the draft really carries unsaved edits")

        val written = kinWithPhoto(loadedRecord, "https://res.cloudinary.com/demo/image/upload/new.jpg")

        assertEquals("https://res.cloudinary.com/demo/image/upload/new.jpg", written.profilePictureUrl)
        assertEquals(loadedRecord.copy(profilePictureUrl = written.profilePictureUrl), written)
        assertEquals(loadedRecord.name, written.name, "the unsaved draft's name must not leak into the write")
        assertEquals(loadedRecord.weight, written.weight, "the unsaved draft's weight must not leak into the write")
        assertEquals(loadedRecord.tags, written.tags)
    }

    @Test
    fun `the write goes out as a whole-document PATCH addressed at the loaded kin`() = runTest {
        val loadedRecord = Kin(_id = "k1", kinfolkId = "kf1", name = "Fido")

        writeKinPhoto(FirestoreClient(), loadedRecord, "https://new.jpg")

        assertEquals("PATCH", JvmFirestoreFixtures.lastWrite?.op)
        assertEquals("kin", JvmFirestoreFixtures.lastWrite?.collection)
        assertEquals("k1", JvmFirestoreFixtures.lastWrite?.id)
    }
}
