package com.kinfolk.portal.portal

/**
 * The household's photo archive, as `getMyKinPhotos` reports it (#399 item 1,
 * built for web in PR #436 and brought to this client by #469).
 *
 * The response keeps two kinds of picture apart, and so do these types.
 * [KinPhoto] is the archive: every image an Auntie attached to a KinTale,
 * newest first, read a page at a time. [KinPortrait] is the one current photo
 * per Kin, the same image the roster shows, overwritten in place on every
 * upload with no history kept anywhere.
 */
data class KinPhoto(
    /** The media_files document id. Stable, and unique within a page. */
    val id: String,
    val url: String,
    /** MIME type, e.g. "image/jpeg". Null when the record never carried one. */
    val contentType: String?,
    /** The KinTale this came from. */
    val taleId: String,
    val taleTitle: String,
    /** When the tale was sent. Null when the tale carries no readable sent time. */
    val takenAtMs: Long?,
) {
    /**
     * True when this should be drawn as a picture. A null [contentType] counts
     * as an image, which is the same call the web Gallery makes: the archive
     * predates the field, and an old photo with no type on record is far more
     * likely than an old video.
     */
    fun isImage(): Boolean = contentType == null || contentType.startsWith("image/")
}

data class KinPortrait(
    val kinId: String,
    val kinName: String,
    val url: String,
)

/**
 * One page of the archive.
 *
 * [hasMore] and [nextBefore] page by TALE, not by photo, because a tale can
 * carry twenty pictures or none. [portraits] arrives on the first page only
 * and is empty on every page after it.
 */
data class KinPhotosResult(
    val photos: List<KinPhoto>,
    val portraits: List<KinPortrait>,
    val hasMore: Boolean,
    val nextBefore: Long?,
)
