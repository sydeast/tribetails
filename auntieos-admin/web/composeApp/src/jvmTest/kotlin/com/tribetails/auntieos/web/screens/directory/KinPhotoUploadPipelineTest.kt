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
 * [runKinPhotoUploadPipeline], [kinWithPhoto] and [writeKinPhoto] are the fix
 * (#895 made the write a merge naming only `profilePictureUrl`),
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
            write       = { url -> assertEquals(uploaded.storageUrl, url); WriteResult.Ok(Kin(_id = "k1", profilePictureUrl = url)) },
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
            write       = { writeCalled = true; WriteResult.Ok(Kin()) },
            onPhotoUrl  = { photoUrl = it },
            onToast     = { toast = it },
        )

        assertNull(photoUrl)
        assertFalse(writeCalled, "a rejected upload must never reach the write")
        assertEquals("Photo upload failed: Selected media exceeds the 50MB limit" to ToastKind.Error, toast)
    }

    /**
     * #895: a Save that completes while the upload is still running moves the
     * baseline to its draft. When the photo write lands afterwards, `onLoaded`
     * goes through [kinBaselineAfterPhotoWrite], which takes only the photo from
     * the written record, never the stale `base` captured on click.
     */
    @Test
    fun `a Save that completes before the photo write keeps its saved fields in the baseline`() = runTest {
        val clickedBase = Kin(_id = "k1", kinfolkId = "kf1", name = "Fido", weight = "40", profilePictureUrl = "https://old.jpg")
        val savedDraft = clickedBase.copy(name = "Fido Jr.", weight = "42")
        var loaded: Kin? = clickedBase
        val uploaded = photo()

        runKinPhotoUploadPipeline(
            previousUrl = clickedBase.profilePictureUrl,
            upload      = { WriteResult.Ok(uploaded) },
            write       = { url ->
                loaded = savedDraft
                WriteResult.Ok(clickedBase.copy(profilePictureUrl = url))
            },
            onPhotoUrl  = {},
            onLoaded    = { loaded = kinBaselineAfterPhotoWrite(loaded, it) },
            onToast     = {},
        )

        assertEquals(savedDraft.copy(profilePictureUrl = uploaded.storageUrl), loaded)
    }

    @Test
    fun `with no baseline yet the written record becomes the baseline`() {
        val written = Kin(_id = "k1", profilePictureUrl = "https://new.jpg")
        assertEquals(written, kinBaselineAfterPhotoWrite(null, written))
    }

    @Test
    fun `a failed photo write leaves the baseline alone`() = runTest {
        var loadedCalled = false
        runKinPhotoUploadPipeline(
            previousUrl = "https://old.jpg",
            upload      = { WriteResult.Ok(photo()) },
            write       = { WriteResult.Err("Not signed in") },
            onPhotoUrl  = {},
            onLoaded    = { loadedCalled = true },
            onToast     = {},
        )
        assertFalse(loadedCalled, "a failed write must not move the baseline")
    }

    // ---- kinWithPhoto / writeKinPhoto: the real merge write, proving the mask ----

    /**
     * [kinWithPhoto] carries every field of the loaded record forward unchanged
     * except the photo. An operator's typed-but-unsaved edit (a new name, say)
     * lives solely in the screen's Compose state, which it never reads.
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

        assertEquals(loadedRecord.copy(profilePictureUrl = written.profilePictureUrl), written)
    }

    /** #895 (issue comment from the #894 review): the photo write is a merge naming only `profilePictureUrl`. */
    @Test
    fun `a photo change merges only profilePictureUrl on the loaded kin`() = runTest {
        val loadedRecord = Kin(_id = "k1", kinfolkId = "kf1", name = "Fido", tags = listOf("Reactive"))

        writeKinPhoto(FirestoreClient(), loadedRecord, "https://new.jpg")

        assertEquals("MERGE", JvmFirestoreFixtures.lastWrite?.op)
        assertEquals("kin", JvmFirestoreFixtures.lastWrite?.collection)
        assertEquals("k1", JvmFirestoreFixtures.lastWrite?.id)
        assertEquals(setOf("profilePictureUrl"), JvmFirestoreFixtures.lastWrite?.fields)
    }

    @Test
    fun `an unchanged photo url writes nothing`() = runTest {
        val loadedRecord = Kin(_id = "k1", profilePictureUrl = "https://same.jpg")

        val result = writeKinPhoto(FirestoreClient(), loadedRecord, "https://same.jpg")

        assertEquals(WriteResult.Ok(loadedRecord), result)
        assertNull(JvmFirestoreFixtures.lastWrite, "no field changed, so nothing should be written")
    }
}
