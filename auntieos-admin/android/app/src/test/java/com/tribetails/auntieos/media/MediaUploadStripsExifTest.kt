package com.tribetails.auntieos.media

import com.tribetails.auntieos.data.model.MediaType
import io.mockk.mockk
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #583: photo location metadata does not survive an upload.
 *
 * Android posts photo bytes straight to api.cloudinary.com — nothing of ours
 * touches them in flight — so the strip is carried by the SIGNATURE: the signer
 * folds `transformation=fl_force_strip` into the signature base, and Cloudinary
 * recomputes that signature over the fields it actually receives. Two things
 * therefore have to hold on this side, and neither is provable by reading a
 * constant:
 *
 *   1. the client asks for the right KIND, so a photo is signed with the strip
 *      and a video is not signed with an image-only transformation Cloudinary
 *      would reject; and
 *   2. the signed instruction actually lands in the multipart body that goes
 *      over the wire.
 *
 * A missing field is not a quiet leak — it is an Invalid Signature, so uploads
 * break loudly. But it still has to be there for a photo to store at all.
 */
class MediaUploadStripsExifTest {

    private fun manager() = MediaUploadManager(mockk(relaxed = true), mockk(relaxed = true))

    private fun auth(transformation: String, tags: String = "") = MediaUploadManager.SignedUploadAuth(
        cloudName = "tribetails",
        apiKey = "key123",
        timestamp = 1_700_000_000L,
        signature = "sig",
        folder = "tribetails/kinfolk/kf1",
        transformation = transformation,
        tags = tags,
    )

    /** Field names in the multipart body, read back off each part's Content-Disposition. */
    private fun fieldNames(body: MultipartBody): List<String> =
        (0 until body.size).mapNotNull { i ->
            body.part(i).headers?.get("Content-Disposition")
                ?.substringAfter("name=\"", "")
                ?.substringBefore("\"")
                ?.takeIf { it.isNotEmpty() }
        }

    private fun bodyWith(transformation: String, tags: String = ""): MultipartBody = manager().buildCloudinaryUploadBody(
        auth(transformation, tags),
        "bytes".toRequestBody("image/jpeg".toMediaTypeOrNull()),
        "beach.jpg",
    )

    // ── 1. the kind the client declares ─────────────────────────────────────

    @Test
    fun `a photo asks the signer for the image signature, which is the one that strips`() {
        assertEquals("image", manager().cloudinaryResourceKind(MediaType.IMAGE))
    }

    @Test
    fun `a video asks for the video signature, so no image-only flag is signed onto it`() {
        assertEquals("video", manager().cloudinaryResourceKind(MediaType.VIDEO))
    }

    @Test
    fun `audio and documents are raw, the other kind Cloudinary must not be handed an image flag for`() {
        assertEquals("raw", manager().cloudinaryResourceKind(MediaType.AUDIO))
        assertEquals("raw", manager().cloudinaryResourceKind(MediaType.DOCUMENT))
    }

    // ── 2. the instruction reaches the wire ─────────────────────────────────

    @Test
    fun `the signed strip instruction is posted in the multipart body`() {
        val names = fieldNames(bodyWith("fl_force_strip"))
        assertTrue(
            "transformation must be posted or Cloudinary rebuilds a different signature; got $names",
            names.contains("transformation"),
        )
        // and the rest of the signed set is still exactly what it was.
        assertTrue(names.containsAll(listOf("file", "api_key", "timestamp", "signature", "folder")))
    }

    @Test
    fun `nothing extra is posted when the signer signed no transformation`() {
        // Video and raw uploads: posting an UNSIGNED field is the same Invalid
        // Signature as dropping a signed one, so blank must mean "send none".
        val names = fieldNames(bodyWith(""))
        assertFalse("blank transformation must not be posted; got $names", names.contains("transformation"))
        assertTrue(names.containsAll(listOf("file", "api_key", "timestamp", "signature", "folder")))
    }

    @Test
    fun `an absent transformation on the signer response defaults to blank, not to a stray field`() {
        // A signer that predates #583 sends no `transformation` key at all.
        val legacy = MediaUploadManager.SignedUploadAuth(
            cloudName = "tribetails",
            apiKey = "key123",
            timestamp = 1_700_000_000L,
            signature = "sig",
            folder = "tribetails/kinfolk/kf1",
        )
        assertEquals("", legacy.transformation)
    }
    // ── 3. #593: the video half, carried by the same signature ──────────────
    //
    // A video cannot be stripped inside the upload the way a photo is, so the
    // signer tags it `needs-gps-strip` instead and a Cloud Function strips it
    // afterwards. The tag rides in on the SIGNATURE for the same reason the
    // photo strip does: a signed field is a field this client is forced to
    // send, and one it could never have invented on its own. Without it a
    // video that uploaded successfully and then failed to write its Firestore
    // row would be invisible to everything.
    @Test
    fun `the signed pending-strip tag is posted in the multipart body`() {
        val names = fieldNames(bodyWith(transformation = "", tags = "needs-gps-strip"))
        assertTrue(
            "tags must be posted or Cloudinary rebuilds a different signature; got $names",
            names.contains("tags"),
        )
        assertTrue(names.containsAll(listOf("file", "api_key", "timestamp", "signature", "folder")))
        // ...and a video is still signed with NO transformation.
        assertFalse(names.contains("transformation"))
    }
    @Test
    fun `no tags field is posted when the signer signed none`() {
        // Image and raw uploads: posting an UNSIGNED field is the same Invalid
        // Signature as dropping a signed one, so blank must mean "send none".
        val names = fieldNames(bodyWith(transformation = "fl_force_strip", tags = ""))
        assertFalse("blank tags must not be posted; got $names", names.contains("tags"))
        assertTrue(names.contains("transformation"))
    }
    @Test
    fun `an absent tags key on the signer response defaults to blank, not to a stray field`() {
        // A signer that predates #593 sends no `tags` key at all.
        val legacy = MediaUploadManager.SignedUploadAuth(
            cloudName = "tribetails",
            apiKey = "key123",
            timestamp = 1_700_000_000L,
            signature = "sig",
            folder = "tribetails/kinfolk/kf1",
        )
        assertEquals("", legacy.tags)
        assertFalse(fieldNames(manager().buildCloudinaryUploadBody(
            legacy,
            "bytes".toRequestBody("video/mp4".toMediaTypeOrNull()),
            "clip.mp4",
        )).contains("tags"))
    }
}
