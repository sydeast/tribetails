package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kinfolk
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
 * #853: KinfolkEditScreen's "Change photo" control used to save via `build()`,
 * which serializes the WHOLE edit form, so a photo change silently persisted
 * every unsaved field the operator had typed elsewhere on the screen, and
 * "Photo updated." showed even when the underlying write failed (the
 * WriteResult was never checked).
 *
 * [runKinfolkPhotoUploadPipeline] and [writeKinfolkPhoto] are the fix,
 * extracted the same way `runAvatarUploadPipeline` is in SettingsScreen.kt so
 * a fake upload/write can drive every outcome without a live Cloudinary
 * upload, a real Firestore write, or a Swing file picker (none of which this
 * JVM test environment can exercise through the real "Change photo" click).
 */
class KinfolkPhotoUploadPipelineTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun photo(url: String = "https://res.cloudinary.com/demo/image/upload/new.jpg") =
        MediaFile(_id = "media-1", storageUrl = url)

    // ---- runKinfolkPhotoUploadPipeline: pure, fake upload/write ----

    @Test
    fun `a successful upload and write shows the photo and the success toast only after the write lands`() = runTest {
        var photoUrl: String? = null
        var loadedRecord: Kinfolk? = null
        var toast: Pair<String, ToastKind>? = null
        val uploaded = photo()
        val written = Kinfolk(_id = "kf1", profilePictureUrl = uploaded.storageUrl)

        runKinfolkPhotoUploadPipeline(
            previousUrl = "https://old.jpg",
            upload      = { WriteResult.Ok(uploaded) },
            write       = { url -> assertEquals(uploaded.storageUrl, url); WriteResult.Ok(written) },
            onPhotoUrl  = { photoUrl = it },
            onLoaded    = { loadedRecord = it },
            onToast     = { toast = it },
        )

        assertEquals(uploaded.storageUrl, photoUrl)
        assertEquals(written, loadedRecord)
        assertEquals("Photo updated." to ToastKind.Success, toast)
    }

    @Test
    fun `a failed write reverts the preview and never shows the success toast`() = runTest {
        val seen = mutableListOf<String>()
        val toasts = mutableListOf<Pair<String, ToastKind>>()
        var loadedRecord: Kinfolk? = null
        val uploaded = photo()

        runKinfolkPhotoUploadPipeline(
            previousUrl = "https://old.jpg",
            upload      = { WriteResult.Ok(uploaded) },
            write       = { WriteResult.Err("Not signed in") },
            onPhotoUrl  = { seen += it },
            onLoaded    = { loadedRecord = it },
            onToast     = { toasts += it },
        )

        // Optimistic preview of the new photo, then reverted back to the old one.
        assertEquals(listOf(uploaded.storageUrl, "https://old.jpg"), seen)
        assertNull(loadedRecord, "a failed write must never advance the loaded record")
        // Exactly one toast, and it is never the success one: a caller that
        // fired both "Photo updated." and the error would still be caught here,
        // unlike a last-write-wins single toast variable.
        assertEquals(listOf("Photo update failed: Not signed in" to ToastKind.Error), toasts)
        assertTrue(toasts.none { it.first == "Photo updated." }, "a failed write must never show the success toast")
    }

    @Test
    fun `a failed upload never touches the preview and shows the upload's own error`() = runTest {
        var photoUrl: String? = null
        var toast: Pair<String, ToastKind>? = null
        var writeCalled = false

        runKinfolkPhotoUploadPipeline(
            previousUrl = "https://old.jpg",
            upload      = { WriteResult.Err("Selected media exceeds the 50MB limit") },
            write       = { writeCalled = true; WriteResult.Ok(Kinfolk()) },
            onPhotoUrl  = { photoUrl = it },
            onLoaded    = {},
            onToast     = { toast = it },
        )

        assertNull(photoUrl)
        assertFalse(writeCalled, "a rejected upload must never reach the write")
        assertEquals("Photo upload failed: Selected media exceeds the 50MB limit" to ToastKind.Error, toast)
    }

    // ---- writeKinfolkPhoto: the real merge write, proving the mask ----

    /**
     * The "unsaved edit" a stray `build()` used to leak in is simulated here by
     * a draft that differs from the loaded record; [writeKinfolkPhoto] only
     * ever reads [loadedRecord] (an operator's typed-but-unsaved gate code
     * lives solely in the screen's Compose state, which this function has no
     * access to at all) and sends a merge naming just `profilePictureUrl`.
     */
    @Test
    fun `a photo change merges only profilePictureUrl even with other unsaved edits sitting nearby`() = runTest {
        val loadedRecord = Kinfolk(
            _id = "kf1",
            firstName = "Dana",
            lastName = "Mercer",
            phoneNumber = "8055550100",
            email = "dana@example.com",
            serviceAddress = "12 Main St",
            gateCode = "1234",
            status = "prospect",
            tags = listOf("VIP"),
        )
        val unsavedDraft = loadedRecord.copy(gateCode = "9999", firstName = "Danielle")
        assertNotEquals(loadedRecord, unsavedDraft, "sanity: the draft really carries unsaved edits")

        writeKinfolkPhoto(FirestoreClient(), loadedRecord, "https://res.cloudinary.com/demo/image/upload/new.jpg")

        assertEquals(setOf("profilePictureUrl"), JvmFirestoreFixtures.lastWrite?.fields)
        assertEquals("kinfolk", JvmFirestoreFixtures.lastWrite?.collection)
        assertEquals("kf1", JvmFirestoreFixtures.lastWrite?.id)
    }

    @Test
    fun `an unchanged photo url writes nothing`() = runTest {
        val loadedRecord = Kinfolk(_id = "kf1", profilePictureUrl = "https://same.jpg")

        val result = writeKinfolkPhoto(FirestoreClient(), loadedRecord, "https://same.jpg")

        assertEquals(WriteResult.Ok(loadedRecord), result)
        assertNull(JvmFirestoreFixtures.lastWrite, "no field changed, so nothing should be written")
    }
}
