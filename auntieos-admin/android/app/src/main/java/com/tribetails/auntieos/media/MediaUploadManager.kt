package com.tribetails.auntieos.media

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.tribetails.auntieos.config.CloudinaryConfig
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.source
import org.json.JSONObject
import java.io.File
import java.util.*
import android.webkit.MimeTypeMap

data class UploadProgress(
    val fileName: String,
    val bytesUploaded: Long,
    val totalBytes: Long,
    val percentage: Int = ((bytesUploaded.toDouble() / totalBytes.toDouble()) * 100).toInt()
)

/**
 * Result of a multi-file upload. Successes are never discarded — callers can
 * persist [succeeded] even when [failed] is non-empty. Fail-loud: callers must
 * surface [failed] to the user when it is non-empty.
 */
data class BatchMediaUploadResult(
    val succeeded: List<MediaFile>,
    val failed: List<Pair<android.net.Uri, String>>,
) {
    val totalRequested: Int get() = succeeded.size + failed.size
    val hasFailures: Boolean get() = failed.isNotEmpty()
}

data class UploadResult(
    val isSuccess: Boolean,
    val publicId: String? = null,
    val secureUrl: String? = null,
    val thumbnailUrl: String? = null,
    val deliveryUrl: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val durationSeconds: Int? = null,
    val error: String? = null
)

class MediaUploadManager(
    private val context: Context,
    private val repository: AuntieRepository
) {
    private val httpClient = OkHttpClient()

    suspend fun uploadMedia(
        uri: Uri,
        entityId: String,
        entityType: MediaEntityType,
        description: String = "",
        tags: List<String> = emptyList(),
        /**
         * ISSUE #519: where this media was captured, or null to store no
         * location at all. Defaulted to null so every existing caller keeps
         * writing exactly what it wrote before; only the KinTale composer
         * supplies one, and only when `enablePhotoLocationTagging` and the GPS
         * master switch are both on. See [com.tribetails.auntieos.media.PhotoLocationTagging].
         */
        location: com.tribetails.auntieos.data.model.GeoLocation? = null,
        onProgress: (UploadProgress) -> Unit = {}
    ): Result<MediaFile> = withContext(Dispatchers.IO) {
        var localFile: LocalUploadFile? = null
        try {
            localFile = stageUriForUpload(uri)
            val mediaType = determineMediaType(localFile.mimeType, localFile.file)
            val desiredFileName = generateFileName(localFile.originalFileName, entityType)

            // Upload to Cloudinary
            val uploadResult = uploadToCloudinary(
                file = localFile.file,
                mimeType = localFile.mimeType,
                folder = CloudinaryConfig.getFolderPath(entityType.name, entityId),
                entityType = entityType,
                entityId = entityId,
                mediaType = mediaType,
                onProgress = onProgress
            )

            if (!uploadResult.isSuccess) {
                return@withContext Result.failure(Exception(uploadResult.error ?: "Upload failed"))
            }

            // Create MediaFile object
            val mediaFile = MediaFile(
                entityId = entityId,
                entityType = entityType.name,
                // #3 (2026-06-08): stamp kinfolkId so the gallery scopes kin-tagging to
                // the owning household. When the entity IS a household, entityId is the
                // kinfolkId. Parity with web platformUploadMedia.
                kinfolkId = if (entityType == MediaEntityType.KINFOLK) entityId else "",
                fileName = uploadResult.publicId?.substringAfterLast('/')?.ifBlank { desiredFileName } ?: desiredFileName,
                originalFileName = localFile.originalFileName,
                fileType = mediaType,
                mimeType = localFile.mimeType,
                fileSizeBytes = localFile.file.length(),
                storageUrl = uploadResult.deliveryUrl ?: "",
                thumbnailUrl = uploadResult.thumbnailUrl ?: "",
                cloudinaryPublicId = uploadResult.publicId ?: "",
                gpsStripStatus = gpsStripStatusFor(mediaType),
                uploadedAt = getCurrentTimestamp(),
                // Real signed-in uploader (was hardcoded "auntie"); single-admin fallback.
                uploadedBy = com.google.firebase.auth.FirebaseAuth.getInstance().currentUser?.uid ?: "auntie",
                tags = tags,
                description = description,
                // #802. TOP-LEVEL field, matching web's `durationSeconds` byte for
                // byte -- see MediaFile's field comment. `metadata.duration` below
                // is a second, older copy of the same value that nothing on web
                // (or this app's own readers, as of #802) ever looks at; kept for
                // now rather than removed, but this is the field every renderer
                // reads.
                durationSeconds = uploadResult.durationSeconds ?: 0,
                metadata = MediaMetadata(
                    width = uploadResult.width,
                    height = uploadResult.height,
                    duration = uploadResult.durationSeconds,
                    // Null unless the caller resolved one under the operator's
                    // switch. This is the ONLY site in the app that writes a
                    // coordinate onto a media record.
                    location = location
                )
            )

            // Save to Firestore
            val saveResult = repository.saveMediaFile(mediaFile)
            saveResult.fold(
                onSuccess = {
                    val savedMediaFile = mediaFile.copy(id = it)
                    Result.success(savedMediaFile)
                },
                onFailure = { Result.failure(it) }
            )

        } catch (e: Exception) {
            Result.failure(e)
        } finally {
            localFile?.file?.delete()
        }
    }

    private suspend fun uploadToCloudinary(
        file: File,
        mimeType: String,
        folder: String,
        entityType: MediaEntityType,
        entityId: String,
        mediaType: MediaType,
        onProgress: (UploadProgress) -> Unit
    ): UploadResult {
        onProgress(UploadProgress(file.name, 0, file.length(), 0))
        val uploadAuth = fetchSignedUploadAuth(folder, entityType, entityId, mediaType)

        val requestBody = buildCloudinaryUploadBody(
            uploadAuth,
            ProgressRequestBody(file, mimeType) { bytes, total ->
                onProgress(UploadProgress(file.name, bytes, total))
            },
            file.name,
        )

        val request = Request.Builder()
            .url("https://api.cloudinary.com/v1_1/${uploadAuth.cloudName}/auto/upload")
            .post(requestBody)
            .build()

        val response = httpClient.newCall(request).execute()
        val bodyText = response.body?.string().orEmpty()
        val body = runCatching { JSONObject(bodyText) }.getOrNull()

        if (!response.isSuccessful) {
            return UploadResult(
                isSuccess = false,
                error = body?.optJSONObject("error")?.optString("message")
                    ?: "Cloudinary upload failed (${response.code})"
            )
        }

        val publicIdResult = body?.optString("public_id").orEmpty()
        val secureUrl = body?.optString("secure_url").orEmpty()
        val resourceType = body?.optString("resource_type").orEmpty()
        val format = body?.optString("format").orEmpty()
        val isVideo = resourceType.equals("video", ignoreCase = true) || mediaType == MediaType.VIDEO

        return UploadResult(
            isSuccess = true,
            publicId = publicIdResult,
            secureUrl = secureUrl,
            thumbnailUrl = CloudinaryConfig.getThumbnailUrl(publicIdResult, isVideo),
            deliveryUrl = CloudinaryConfig.getDeliveryUrl(publicIdResult, isVideo, format),
            width = body?.optInt("width"),
            height = body?.optInt("height"),
            durationSeconds = body?.optDouble("duration")?.toInt()
        )
    }

    /**
     * The exact multipart form posted to Cloudinary.
     *
     * #583: the signer signs `transformation=fl_force_strip` for image uploads,
     * which is what makes the STORED ORIGINAL carry no EXIF GPS. Cloudinary
     * recomputes the signature over the fields it RECEIVES, so this field is
     * posted exactly when the signer signed one and never otherwise: a blank
     * value means no transformation was signed (video/raw), and posting one
     * anyway is the same Invalid Signature as dropping a signed one.
     *
     * Internal, and split out of [uploadToCloudinary], so the posted field set
     * is assertable without a network call or a staged file on disk.
     */
    internal fun buildCloudinaryUploadBody(
        auth: SignedUploadAuth,
        fileBody: RequestBody,
        fileName: String,
    ): MultipartBody = MultipartBody.Builder()
        .setType(MultipartBody.FORM)
        .addFormDataPart("file", fileName, fileBody)
        .addFormDataPart("api_key", auth.apiKey)
        .addFormDataPart("timestamp", auth.timestamp.toString())
        .addFormDataPart("signature", auth.signature)
        .addFormDataPart("folder", auth.folder)
        .also { builder ->
            if (auth.transformation.isNotBlank()) {
                builder.addFormDataPart("transformation", auth.transformation)
            }
            // #593. Signed server-side on exactly the same terms.
            if (auth.tags.isNotBlank()) {
                builder.addFormDataPart("tags", auth.tags)
            }
        }
        .build()
    private suspend fun fetchSignedUploadAuth(
        folder: String,
        entityType: MediaEntityType,
        entityId: String,
        mediaType: MediaType,
    ): SignedUploadAuth {
        val idToken = repository.currentAdminIdToken(forceRefresh = false).getOrElse { throw it }
        val payload = JSONObject()
            .put("folder", folder)
            .put("entityType", entityType.name)
            .put("entityId", entityId)
            // #583: tells the signer which incoming transformation to sign. The
            // file's own MIME type decided this (determineMediaType), never a
            // caller, so a photo is always signed with the metadata strip.
            .put("resourceKind", cloudinaryResourceKind(mediaType))
            .toString()
        val request = Request.Builder()
            .url("https://auntieos-ttpc.web.app/api/cloudinary/sign-upload")
            .header("Authorization", "Bearer $idToken")
            .post(payload.toRequestBody("application/json".toMediaTypeOrNull()))
            .build()

        val response = httpClient.newCall(request).execute()
        val bodyText = response.body?.string().orEmpty()
        if (!response.isSuccessful) {
            throw IllegalStateException("Cloudinary signing failed (${response.code}): $bodyText")
        }
        val body = JSONObject(bodyText)
        return SignedUploadAuth(
            cloudName = body.optString("cloudName"),
            apiKey = body.optString("apiKey"),
            timestamp = body.optLong("timestamp"),
            signature = body.optString("signature"),
            folder = body.optString("folder"),
            // Absent on a signer that predates #583: blank means "sign nothing
            // extra, post nothing extra", which is the old request verbatim.
            transformation = body.optString("transformation"),
            // #593. Same defaulting as `transformation`, same reason: a signer
            // that predates it signs no tags, so none are posted.
            tags = body.optString("tags")
        ).also {
            if (it.cloudName.isBlank() || it.apiKey.isBlank() || it.signature.isBlank() || it.folder.isBlank()) {
                error("Cloudinary signing response missing required fields")
            }
        }
    }

    /**
     * #583. Cloudinary's own resource vocabulary for a picked file, sent to the
     * signer so it knows whether to sign the metadata-strip transformation.
     *
     * IMAGE is the only kind that strips: `fl_force_strip` is an image flag,
     * and an incoming transformation on a video would mean re-encoding the
     * whole file inside the upload request. Audio and documents are `raw`.
     *
     * Internal rather than private so the upload contract is testable without
     * a network call or a real Uri.
     */
    /**
     * #593. The initial strip state stamped on a new `media_files` row.
     *
     * Only a VIDEO is queued for the asynchronous location strip. An image was
     * already stripped before Cloudinary stored it (#583), and audio and
     * documents carry no location atom this repo strips, so marking either
     * PENDING would park a permanent false positive in the retry sweep's queue.
     *
     * BLANK, never a "NOT_APPLICABLE" word: the repository DELETES the key when
     * this is blank, so a doc with no async strip to report has no field at
     * all. That is the equality-on-empty-string Firestore trap `kinfolkId`
     * documents, and the same answer.
     *
     * Internal rather than private so the rule is testable without staging a
     * file, a Uri and a Cloudinary round trip.
     */
    internal fun gpsStripStatusFor(mediaType: MediaType): String =
        if (mediaType == MediaType.VIDEO) "PENDING" else ""
    internal fun cloudinaryResourceKind(mediaType: MediaType): String = when (mediaType) {
        MediaType.IMAGE -> "image"
        MediaType.VIDEO -> "video"
        MediaType.AUDIO, MediaType.DOCUMENT -> "raw"
    }
    private fun determineMediaType(mimeType: String, file: File): MediaType {
        val normalizedMime = mimeType.lowercase()
        return when {
            normalizedMime.startsWith("image/") -> MediaType.IMAGE
            normalizedMime.startsWith("video/") -> MediaType.VIDEO
            normalizedMime.startsWith("audio/") -> MediaType.AUDIO
            else -> when (file.extension.lowercase()) {
            "jpg", "jpeg", "png", "gif", "bmp", "webp" -> MediaType.IMAGE
            "mp4", "avi", "mov", "mkv", "wmv", "flv" -> MediaType.VIDEO
            "mp3", "wav", "aac", "ogg", "m4a" -> MediaType.AUDIO
            else -> MediaType.DOCUMENT
            }
        }
    }

    private fun generateFileName(originalName: String, entityType: MediaEntityType): String {
        val timestamp = System.currentTimeMillis()
        val extension = File(originalName).extension
        val prefix = when (entityType) {
            MediaEntityType.KINFOLK -> "kinfolk"
            MediaEntityType.KIN -> "kin"
            MediaEntityType.HOUSEHOLD -> "household"
            MediaEntityType.VISIT_LOG -> "visit"
            MediaEntityType.INVOICE -> "invoice"
            MediaEntityType.TRAINING -> "training"
            MediaEntityType.TRIBAL_INTEL -> "tribalintel"
            MediaEntityType.USER -> "user"
            MediaEntityType.BUSINESS -> "business"
        }
        return "${prefix}_${timestamp}.$extension"
    }

    private fun stageUriForUpload(uri: Uri): LocalUploadFile {
        val resolver = context.contentResolver
        val displayName = queryDisplayName(uri) ?: "upload_${System.currentTimeMillis()}"
        val mimeType = resolver.getType(uri).orEmpty().ifBlank { "application/octet-stream" }
        val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType)
            ?: displayName.substringAfterLast('.', "")
        val suffix = if (extension.isBlank()) "" else ".$extension"
        val tempFile = File.createTempFile("auntie_upload_", suffix, context.cacheDir)
        resolver.openInputStream(uri)?.use { input ->
            tempFile.outputStream().use { output -> input.copyTo(output) }
        } ?: error("Could not open selected media URI for upload")
        if (tempFile.length() <= 0L) {
            error("Selected media file is empty")
        }
        if (tempFile.length() > CloudinaryConfig.MAX_FILE_SIZE) {
            error("Selected media exceeds the ${CloudinaryConfig.MAX_FILE_SIZE / (1024 * 1024)}MB limit")
        }
        return LocalUploadFile(
            file = tempFile,
            originalFileName = displayName,
            mimeType = mimeType
        )
    }

    private fun getCurrentTimestamp(): String {
        return java.time.Instant.now().toString()
    }

    /**
     * Uploads all [uris] and returns a [BatchMediaUploadResult] that carries
     * both [BatchMediaUploadResult.succeeded] and [BatchMediaUploadResult.failed]
     * entries. Successes are never discarded on partial failure — callers must
     * surface the failure list to the user when it is non-empty (fail-loud).
     */
    suspend fun uploadMultipleMedia(
        uris: List<Uri>,
        entityId: String,
        entityType: MediaEntityType,
        onProgress: (Int, Int) -> Unit = { _, _ -> }
    ): Result<BatchMediaUploadResult> {
        val succeeded = mutableListOf<MediaFile>()
        val failed = mutableListOf<Pair<Uri, String>>()

        uris.forEachIndexed { index, uri ->
            onProgress(index, uris.size)

            uploadMedia(uri, entityId, entityType).fold(
                onSuccess = { succeeded.add(it) },
                onFailure = { failed.add(uri to (it.message ?: "Unknown error")) }
            )
        }

        // Always succeed so callers can act on partial results; failures surface
        // via BatchMediaUploadResult.failed — never silently discarded.
        return Result.success(BatchMediaUploadResult(succeeded = succeeded, failed = failed))
    }

    private fun queryDisplayName(uri: Uri): String? {
        val resolver = context.contentResolver
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) return cursor.getString(index)
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/')
    }

    private data class LocalUploadFile(
        val file: File,
        val originalFileName: String,
        val mimeType: String,
    )

    internal data class SignedUploadAuth(
        val cloudName: String,
        val apiKey: String,
        val timestamp: Long,
        val signature: String,
        val folder: String,
        /**
         * #583. The incoming transformation the SERVER signed (`fl_force_strip`
         * for an image, blank otherwise). Signed, therefore not optional: post
         * it verbatim when non-blank, never when blank.
         */
        val transformation: String = "",
        /**
         * #593. The tags the SERVER signed (`needs-gps-strip` for a video,
         * blank otherwise). Signed on exactly the same terms as
         * [transformation]: post it verbatim when non-blank, never when blank.
         *
         * A video's location metadata cannot be stripped inside the upload, so
         * it is stripped asynchronously afterwards. This tag marks the asset as
         * not-yet-stripped at Cloudinary itself, so an upload that succeeded
         * and then failed to write its Firestore row is still findable.
         */
        val tags: String = "",
    )

    private class ProgressRequestBody(
        private val file: File,
        private val mimeType: String,
        private val onProgress: (Long, Long) -> Unit,
    ) : RequestBody() {
        override fun contentType() = mimeType.toMediaTypeOrNull()

        override fun contentLength(): Long = file.length()

        override fun writeTo(sink: BufferedSink) {
            val total = contentLength()
            file.source().use { source ->
                var uploaded = 0L
                var read: Long
                while (source.read(sink.buffer, 8_192).also { read = it } != -1L) {
                    uploaded += read
                    sink.flush()
                    onProgress(uploaded, total)
                }
            }
        }
    }
}
