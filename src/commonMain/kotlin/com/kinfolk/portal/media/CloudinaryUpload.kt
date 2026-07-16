package com.kinfolk.portal.media

/**
 * Signed upload params from any `signXxx` Cloudinary-signing Function
 * (`signKinfolkAvatar`, `signKinPhotoUpload`, ...). Server holds the
 * Cloudinary API secret and signs each upload; client never sees the secret.
 * One shape for every signed-upload surface — the `folder` is what scopes a
 * given signature to one avatar / one kin's photo / etc.
 */
data class CloudinarySignedUpload(
    val cloudName: String,
    val apiKey: String,
    val timestamp: Long,
    val signature: String,
    val folder: String,
    /**
     * Comma-separated formats (e.g. "jpg,png,webp,gif"), signed server-side
     * as part of the signature. MUST be echoed back in the upload POST body
     * exactly as received, or Cloudinary rejects the request as a signature
     * mismatch — every param the server signs has to appear in the request.
     * Blank on a signed result that didn't include it (shouldn't happen for
     * any current signer, but a blank value is simply omitted from the POST
     * rather than sent as an empty field).
     */
    val allowedFormats: String = "",
)

/**
 * POSTs a picked image to Cloudinary's signed upload endpoint and returns
 * the resulting `secure_url`. Returns null on failure (caller surfaces error).
 * Generic across every signed-upload surface (avatar, kin photo, ...) — the
 * signature's `folder` is what scopes where this specific upload lands.
 *
 * Endpoint: `https://api.cloudinary.com/v1_1/{cloudName}/image/upload`.
 * Multipart form fields: `file`, `api_key`, `timestamp`, `signature`,
 * `folder`, `allowed_formats` (when signed's `allowedFormats` is non-blank).
 *
 * Each platform supplies its own implementation:
 * - android: OkHttp (already on classpath via Firebase deps).
 * - js:      fetch + FormData.
 * - jvm:     no-op stub returning null with a warning log (no real picker on desktop).
 */
expect suspend fun uploadImageToCloudinary(
    signed: CloudinarySignedUpload,
    image: PickedImage,
): String?
