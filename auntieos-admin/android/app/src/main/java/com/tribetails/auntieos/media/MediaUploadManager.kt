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
                uploadedAt = getCurrentTimestamp(),
                // Real signed-in uploader (was hardcoded "auntie"); single-admin fallback.
                uploadedBy = com.google.firebase.auth.FirebaseAuth.getInstance().currentUser?.uid ?: "auntie",
                tags = tags,
                description = description,
                metadata = MediaMetadata(
                    width = uploadResult.width,
                    height = uploadResult.height,
                    duration = uploadResult.durationSeconds
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
        val uploadAuth = fetchSignedUploadAuth(folder, entityType, entityId)

        val requestBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "file",
                file.name,
                ProgressRequestBody(file, mimeType) { bytes, total ->
                    onProgress(UploadProgress(file.name, bytes, total))
                }
            )
            .addFormDataPart("api_key", uploadAuth.apiKey)
            .addFormDataPart("timestamp", uploadAuth.timestamp.toString())
            .addFormDataPart("signature", uploadAuth.signature)
            .addFormDataPart("folder", uploadAuth.folder)
            .build()

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

    private suspend fun fetchSignedUploadAuth(folder: String, entityType: MediaEntityType, entityId: String): SignedUploadAuth {
        val idToken = repository.currentAdminIdToken(forceRefresh = false).getOrElse { throw it }
        val payload = JSONObject()
            .put("folder", folder)
            .put("entityType", entityType.name)
            .put("entityId", entityId)
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
            folder = body.optString("folder")
        ).also {
            if (it.cloudName.isBlank() || it.apiKey.isBlank() || it.signature.isBlank() || it.folder.isBlank()) {
                error("Cloudinary signing response missing required fields")
            }
        }
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

    private data class SignedUploadAuth(
        val cloudName: String,
        val apiKey: String,
        val timestamp: Long,
        val signature: String,
        val folder: String,
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
