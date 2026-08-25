package com.tribetails.auntieos.web.data

import kotlinx.serialization.Serializable

/**
 * MediaFile - uploaded photo or video metadata. Mirrors the Android
 * `data/model/DynamicFields.kt#MediaFile` shape so the same Firestore docs
 * round-trip cleanly between platforms. Web uses `_id` (matches the document
 * id alias used by the rest of the web FirestoreClient models).
 */
@Serializable
data class MediaFile(
    val _id: String = "",
    val entityId: String = "",
    val entityType: String = "VISIT_LOG",       // mirrors Android MediaEntityType enum name
    val kinfolkId: String = "",                 // Stage 0I sandbox scope: == testTribeId on test-admin writes so the rules (testOwnsIncoming/Existing) allow them; blank for the operator (media stays keyed by entityId/entityType).
    val fileName: String = "",
    val originalFileName: String = "",
    val fileType: String = "IMAGE",             // "IMAGE" | "VIDEO"
    val mimeType: String = "",
    val fileSizeBytes: Long = 0,
    val storageUrl: String = "",
    val thumbnailUrl: String = "",
    val uploadedAt: String = "",
    val uploadedBy: String = "",
    val tags: List<String> = emptyList(),
    // #13 Gallery: kin tagged IN this image (a list of kin `_id`s). Distinct from the
    // generic free-text [tags]; written from the global Gallery's tag picker.
    val taggedKinIds: List<String> = emptyList(),
    val description: String = "",
    val isProfilePhoto: Boolean = false,
    val durationSeconds: Int = 0,               // videos only
    val width: Int = 0,
    val height: Int = 0,
    val cloudinaryPublicId: String = "",        // kept for delete + transform URL builds
    // #593. State of the asynchronous video location-metadata strip:
    // "PENDING" | "STRIPPED" | "FAILED". Blank on every image (a photo is
    // stripped before Cloudinary stores it, #583, so no async step applies) and
    // on every video predating #593.
    val gpsStripStatus: String = "",
    val gpsStripAttempts: Int = 0,
    val gpsStripError: String = "",
)

/** #13 Gallery: minimal patch body for a taggedKinIds-only doc update. */
@Serializable
data class MediaTagsPatch(val taggedKinIds: List<String> = emptyList())

object KinTaleMediaConfig {
    /** Cloudinary cloud name. Public - safe to ship in browser code.
     *  Must match the CLOUDINARY_CLOUD_NAME secret used by signCloudinaryUpload. */
    const val CLOUD_NAME = "tribetails"

    /** Cap on photos + videos per KinTale (combined). */
    const val MAX_FILES_PER_TALE = 75

    /** Hard clip applied to the *delivered* video URL via Cloudinary `du_15.0`. */
    const val VIDEO_CLIP_SECONDS = 15

    /** Folder layout matches Android: tribetails/visit_log/{sessionId} */
    fun folderFor(sessionId: String): String = "tribetails/visit_log/$sessionId"

    /**
     * Build a thumbnail URL for either an image or a clipped video frame.
     * Same shape as Android `CloudinaryConfig.getThumbnailUrl`.
     */
    fun thumbnailUrl(publicId: String, isVideo: Boolean): String {
        val resource = if (isVideo) "video" else "image"
        val videoParams = if (isVideo) ",so_2.0" else ""
        return "https://res.cloudinary.com/$CLOUD_NAME/$resource/upload/" +
            "w_300,h_300,c_fill,q_auto,f_auto$videoParams/$publicId" +
            if (isVideo) ".jpg" else ""
    }

    /**
     * Delivery URL - for videos we apply `du_15.0` so the kinfolk-facing playback
     * is already trimmed. The original full-length asset stays in Cloudinary
     * untouched (we can lift the cap later by editing this fn alone).
     */
    fun deliveryUrl(publicId: String, isVideo: Boolean, format: String): String {
        val resource = if (isVideo) "video" else "image"
        val transform = if (isVideo) "du_$VIDEO_CLIP_SECONDS.0,q_auto,f_auto" else "q_auto,f_auto"
        val ext = if (format.isNotBlank()) ".$format" else ""
        return "https://res.cloudinary.com/$CLOUD_NAME/$resource/upload/$transform/$publicId$ext"
    }
}

@Serializable
data class CloudinarySignedUpload(
    val cloudName: String,
    val apiKey: String,
    val timestamp: Long,
    val signature: String,
    val folder: String,
    /**
     * #583. The incoming transformation the SERVER signed: `fl_force_strip`
     * for an image (so the stored original carries no EXIF GPS), blank for a
     * video or a raw file. Cloudinary recomputes the signature over the fields
     * it receives, so this must be posted verbatim when non-blank and must not
     * be posted at all when blank. Blank is also what a signer that predates
     * #583 returns, which is why it defaults rather than being required.
     */
    val transformation: String = "",
    /**
     * #593. The tags the SERVER signed (`needs-gps-strip` for a video, blank
     * otherwise). Signed on exactly the same terms as [transformation]: post it
     * verbatim when non-blank, never when blank.
     *
     * A video's location metadata cannot be stripped inside the upload the way
     * a photo's is, so it is stripped asynchronously afterwards. This tag marks
     * the asset as not-yet-stripped at Cloudinary itself, so an upload that
     * succeeded and then failed to write its Firestore row is still findable.
     */
    val tags: String = "",
    val entityType: String,
    val entityId: String,
)
