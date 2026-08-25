package com.tribetails.auntieos.web.data

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * #518: desktop's admin/operator profile-photo upload (`SettingsScreen.kt`'s
 * ProfilePanel) routes through `platformUploadMedia` -> [JvmMediaUpload.upload].
 * That pipeline talks to a live signed-upload endpoint + Cloudinary, so a full
 * successful-upload run cannot be exercised here without real network + a signed-in
 * Firebase session (no mock seam exists for it, unlike the Firestore doc reads/writes
 * `JvmFirestoreFixtures` fakes) - the same category of external-dependency limit as
 * needing a real secret. What IS unit-testable, and what this file pins down, are the
 * synchronous REJECTED-path guards that run before any network call: a blank entityId,
 * and [JvmMediaUpload.MAX_FILE_SIZE_BYTES] (added by #518 for parity with Android's
 * `CloudinaryConfig.MAX_FILE_SIZE` - desktop had a picker-level image-extension filter
 * but no byte-size cap at all before this).
 */
class JvmMediaUploadValidationTest {

    @Test
    fun `blank entityId is rejected before any network call`() = runTest {
        val result = JvmMediaUpload.upload(
            entityId = "",
            entityType = "USER",
            bytes = byteArrayOf(1, 2, 3),
            mimeType = "image/jpeg",
        )
        val err = assertIs<WriteResult.Err>(result)
        assertEquals("uploadMedia requires a non-blank entityId", err.message)
    }

    @Test
    fun `a file over the size cap is rejected before any network call`() = runTest {
        val oversized = ByteArray((JvmMediaUpload.MAX_FILE_SIZE_BYTES + 1).toInt())
        val result = JvmMediaUpload.upload(
            entityId = "operator-uid",
            entityType = "USER",
            bytes = oversized,
            mimeType = "image/jpeg",
        )
        val err = assertIs<WriteResult.Err>(result)
        assertEquals(
            "Selected media exceeds the ${JvmMediaUpload.MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit",
            err.message,
        )
    }

    @Test
    fun `a file at exactly the size cap is NOT rejected on size`() = runTest {
        // Proves the cap is size > MAX, not size >= MAX (an off-by-one would reject
        // the boundary file too). This still fails past the size check - a plain
        // unit test has no live network/Firebase session - but whatever it fails
        // with must NOT be the size-limit message, which is the one thing that
        // would prove the size gate itself rejected a boundary-legal file. (Not
        // pinned to the exact downstream message: this JVM may or may not have a
        // persisted Firebase session depending on the machine it runs on, so the
        // failure could be "sign-in required" or a network error - either is fine,
        // only the size message would be a real failure here.)
        val atLimit = ByteArray(JvmMediaUpload.MAX_FILE_SIZE_BYTES.toInt())
        val result = JvmMediaUpload.upload(
            entityId = "operator-uid",
            entityType = "USER",
            bytes = atLimit,
            mimeType = "image/jpeg",
        )
        val err = assertIs<WriteResult.Err>(result)
        assertNotEquals(
            "Selected media exceeds the ${JvmMediaUpload.MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit",
            err.message,
        )
    }
}
/**
 * #583: photo location metadata does not survive a desktop upload either.
 *
 * Desktop posts the picked bytes straight to api.cloudinary.com, so the strip
 * is carried by the SIGNATURE: the signer folds `transformation=fl_force_strip`
 * into the signature base for an image, and Cloudinary recomputes that
 * signature over the fields it actually receives. This pins both halves of what
 * desktop is responsible for — asking for the right kind, and putting the
 * signed instruction on the wire — without needing a live endpoint.
 */
class JvmMediaUploadStripsExifTest {
    private fun signed(transformation: String) = CloudinarySignedUpload(
        cloudName = "tribetails",
        apiKey = "key123",
        timestamp = 1_700_000_000L,
        signature = "sig",
        folder = "tribetails/entity/kf1",
        transformation = transformation,
        entityType = "KINFOLK",
        entityId = "kf1",
    )
    private fun fieldNames(transformation: String): List<String> =
        JvmMediaUpload.uploadFormData(
            fileBytes = byteArrayOf(1, 2, 3),
            fileName = "beach.jpg",
            mimeType = "image/jpeg",
            sign = signed(transformation),
        ).map { it.name.orEmpty() }
    @Test
    fun `a photo asks the signer for the image signature, which is the one that strips`() {
        assertEquals("image", JvmMediaUpload.cloudinaryResourceKind("image/jpeg"))
        assertEquals("image", JvmMediaUpload.cloudinaryResourceKind("IMAGE/HEIC"))
    }
    @Test
    fun `a video asks for the video signature, so no image-only flag is signed onto it`() {
        assertEquals("video", JvmMediaUpload.cloudinaryResourceKind("video/mp4"))
    }
    @Test
    fun `anything else is raw, including a blank mime type`() {
        assertEquals("raw", JvmMediaUpload.cloudinaryResourceKind("application/pdf"))
        assertEquals("raw", JvmMediaUpload.cloudinaryResourceKind(""))
    }
    @Test
    fun `the signed strip instruction is posted in the multipart form`() {
        val names = fieldNames("fl_force_strip")
        assertTrue(
            names.contains("transformation"),
            "transformation must be posted or Cloudinary rebuilds a different signature; got $names",
        )
        assertTrue(names.containsAll(listOf("file", "api_key", "timestamp", "signature", "folder")))
    }
    @Test
    fun `nothing extra is posted when the signer signed no transformation`() {
        val names = fieldNames("")
        assertFalse(names.contains("transformation"), "blank transformation must not be posted; got $names")
        assertTrue(names.containsAll(listOf("file", "api_key", "timestamp", "signature", "folder")))
    }
}
