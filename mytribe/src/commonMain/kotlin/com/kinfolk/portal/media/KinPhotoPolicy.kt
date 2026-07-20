package com.kinfolk.portal.media

/**
 * Pure, platform-free rules for kin photo uploads, applied before the picked
 * image is sent to Cloudinary (`signKinPhotoUpload` + direct upload). Cheap,
 * client-side fail-fast — Cloudinary itself is the authoritative size/format
 * enforcement on the actual upload.
 */
object KinPhotoPolicy {
    /**
     * Decoded-byte cap. The old base64-through-a-callable path capped this at
     * 2MB because of Firebase callable payload limits, not because 2MB is the
     * right photo size — direct-to-Cloudinary upload has no such constraint,
     * so this now sits at Cloudinary's own free-tier per-image ceiling.
     */
    const val MAX_BYTES: Int = 10 * 1024 * 1024

    val ALLOWED_MIME_TYPES: Set<String> = setOf("image/jpeg", "image/png", "image/webp", "image/gif")

    /** Returns a user-facing problem description, or null when the image is acceptable. */
    fun validate(image: PickedImage): String? = when {
        image.bytes.isEmpty() -> "That file looks empty — pick a different photo."
        image.bytes.size > MAX_BYTES -> "Photos need to be 10MB or smaller."
        image.mimeType.lowercase() !in ALLOWED_MIME_TYPES -> "Use a JPG, PNG, WebP, or GIF image."
        else -> null
    }

    /**
     * Collapses a display file name to one safe path segment: keeps only
     * [A-Za-z0-9._-], drops directory parts, trims leading dots/underscores,
     * caps at 80 chars. Empty results fall back to "photo". The server applies
     * its own (authoritative) version of the same rule.
     */
    fun sanitizeFileName(raw: String): String {
        val lastSegment = raw.split('/', '\\').last()
        val cleaned = lastSegment
            .map { c -> if (c.isLetterOrDigit() && c.code < 128 || c == '.' || c == '_' || c == '-') c else '_' }
            .joinToString("")
            .trimStart('.', '_')
            .take(80)
        return cleaned.ifBlank { "photo" }
    }
}
