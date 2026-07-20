package com.tribetails.auntieos.config

object CloudinaryConfig {
    // Public Cloudinary configuration only. Do not ship API secrets in the app.

    // Must match the CLOUDINARY_CLOUD_NAME secret used by signCloudinaryUpload.
    const val CLOUD_NAME = "tribetails"

    // Quality settings
    const val IMAGE_QUALITY = "auto:good"
    const val THUMBNAIL_SIZE = 300
    const val MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB
    const val VIDEO_CLIP_SECONDS = 15

    // Folder structure
    const val BASE_FOLDER = "tribetails"

    fun getFolderPath(entityType: String, entityId: String): String {
        return "$BASE_FOLDER/${entityType.lowercase()}/$entityId"
    }

    fun getThumbnailUrl(publicId: String, isVideo: Boolean = false): String {
        val resourceType = if (isVideo) "video" else "image"
        val videoParams = if (isVideo) ",so_2.0" else ""
        return "https://res.cloudinary.com/$CLOUD_NAME/$resourceType/upload/w_$THUMBNAIL_SIZE,h_$THUMBNAIL_SIZE,c_fill,q_auto,f_auto${videoParams}/$publicId${if (isVideo) ".jpg" else ""}"
    }

    fun getDeliveryUrl(publicId: String, isVideo: Boolean, format: String): String {
        val resourceType = if (isVideo) "video" else "image"
        val transform = if (isVideo) "du_$VIDEO_CLIP_SECONDS.0,q_auto,f_auto" else "q_auto,f_auto"
        val ext = if (format.isNotBlank()) ".$format" else ""
        return "https://res.cloudinary.com/$CLOUD_NAME/$resourceType/upload/$transform/$publicId$ext"
    }

    fun getOptimizedUrl(publicId: String, width: Int? = null, height: Int? = null): String {
        val sizeParams = when {
            width != null && height != null -> "w_$width,h_$height,c_fill,"
            width != null -> "w_$width,"
            height != null -> "h_$height,"
            else -> ""
        }
        return "https://res.cloudinary.com/$CLOUD_NAME/image/upload/${sizeParams}q_auto,f_auto/$publicId"
    }
}
