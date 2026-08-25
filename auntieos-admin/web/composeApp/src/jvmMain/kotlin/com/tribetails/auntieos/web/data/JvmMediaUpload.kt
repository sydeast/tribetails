package com.tribetails.auntieos.web.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.java.Java
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentDisposition
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.File
import java.time.Instant
import javax.swing.JFileChooser
import javax.swing.SwingUtilities
import javax.swing.filechooser.FileNameExtensionFilter

/**
 * Desktop (JVM) media upload. Mirrors the proven wasm + Android pipeline:
 *   pick a file -> POST /api/cloudinary/sign-upload (Bearer id token) ->
 *   multipart upload to Cloudinary -> write a `media_files` doc via REST.
 *
 * The web KinfolkEditScreen/KinEditScreen call uploadMedia with an empty ByteArray
 * (the platform owns the picker), so JVM opens a Swing JFileChooser. If real bytes
 * are ever passed they are used directly instead of prompting.
 *
 * Fail-loud: every failure returns a WriteResult.Err with the underlying message;
 * nothing is faked or silently swallowed.
 */
internal object JvmMediaUpload {
    private const val SIGN_URL = "https://auntieos-ttpc.web.app/api/cloudinary/sign-upload"
    private val codec = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }
    private val http = HttpClient(Java)

    // Also doubles as the file-type gate for the picker branch below: the dialog
    // itself only lets the user select one of these extensions
    // (isAcceptAllFileFilterUsed = false), so [guessMime] can never resolve to
    // anything outside this set for a picker-driven upload.
    private val IMAGE_EXTENSIONS = arrayOf("jpg", "jpeg", "png", "gif", "webp", "bmp", "heic")

    /** Parity with Android's `CloudinaryConfig.MAX_FILE_SIZE`. */
    const val MAX_FILE_SIZE_BYTES: Long = 50L * 1024 * 1024

    suspend fun upload(
        entityId: String,
        entityType: String,
        bytes: ByteArray,
        mimeType: String,
    ): WriteResult<MediaFile> {
        if (entityId.isBlank()) return WriteResult.Err("uploadMedia requires a non-blank entityId")

        // 1. Resolve the file bytes (use provided bytes, else prompt with a picker).
        val (fileBytes, fileName, resolvedMime) = if (bytes.isNotEmpty()) {
            Triple(bytes, "upload_${Instant.now().toEpochMilli()}", mimeType.ifBlank { "application/octet-stream" })
        } else {
            val picked = pickImageFile() ?: return WriteResult.Err("No file selected")
            Triple(picked.readBytes(), picked.name, guessMime(picked))
        }
        if (fileBytes.isEmpty()) return WriteResult.Err("Selected file is empty")
        // Size validation: the JFileChooser filter (picker branch) restricts extension,
        // not bytes, and the direct-bytes branch has no OS-level gate at all - so this is
        // the one place both branches are checked. Fail-loud with the same wording
        // pattern Android's MediaUploadManager uses (parity, #518).
        if (fileBytes.size > MAX_FILE_SIZE_BYTES) {
            return WriteResult.Err("Selected media exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit")
        }
        return try {
            // 2. Fetch a signed-upload grant from the same backend the web/Android apps use.
            val token = jvmFirebaseIdToken() ?: return WriteResult.Err("Admin sign-in required before media upload")
            val folder = "tribetails/entity/$entityId"
            // #583: the file's own MIME type picks the resource kind, so a photo
            // is always signed with the metadata strip and a video is never
            // signed with an image-only transformation Cloudinary would reject.
            val sign = fetchSignedUpload(token, folder, entityType, entityId, cloudinaryResourceKind(resolvedMime))

            // 3. Multipart upload to Cloudinary.
            val cloudResp = http.post("https://api.cloudinary.com/v1_1/${sign.cloudName}/auto/upload") {
                setBody(
                    MultiPartFormDataContent(
                        formData {
                            append("file", fileBytes, Headers.build {
                                append(HttpHeaders.ContentType, resolvedMime)
                                append(HttpHeaders.ContentDisposition, ContentDisposition.File.withParameter(ContentDisposition.Parameters.FileName, fileName).toString())
                            })
                            append("api_key", sign.apiKey)
                            append("timestamp", sign.timestamp.toString())
                            append("signature", sign.signature)
                            append("folder", sign.folder)
                            // #583: signed server-side, so it is posted exactly when
                            // it was signed and never otherwise. A blank value means
                            // the signer signed no transformation.
                            if (sign.transformation.isNotBlank()) append("transformation", sign.transformation)
                        }
                    )
                )
            }
            val cloudText = cloudResp.bodyAsText()
            if (!cloudResp.status.isSuccess()) {
                val msg = runCatching {
                    codec.parseToJsonElement(cloudText).jsonObject["error"]?.jsonObject
                        ?.get("message")?.jsonPrimitive?.content
                }.getOrNull() ?: "Cloudinary upload failed (${cloudResp.status.value})"
                return WriteResult.Err(msg)
            }
            val obj = codec.parseToJsonElement(cloudText).jsonObject
            val publicId  = obj["public_id"]?.jsonPrimitive?.content.orEmpty()
            val secureUrl = obj["secure_url"]?.jsonPrimitive?.content.orEmpty()
            val resType   = obj["resource_type"]?.jsonPrimitive?.content.orEmpty()
            val format    = obj["format"]?.jsonPrimitive?.content.orEmpty()
            val isVideo   = resType.equals("video", ignoreCase = true)

            // 4. Write media_files metadata (same shape as wasm/Android so docs round-trip).
            val record = MediaFile(
                entityId = entityId,
                entityType = entityType,
                // #3 (2026-06-08): stamp kinfolkId so the gallery scopes kin-tagging to
                // the owning household (entityType "kinfolk" -> entityId is the kinfolkId).
                // Parity with wasm/Android.
                kinfolkId = if (entityType.equals("kinfolk", ignoreCase = true)) entityId else "",
                fileName = publicId.substringAfterLast('/').ifBlank { fileName },
                originalFileName = fileName,
                fileType = if (isVideo) "VIDEO" else "IMAGE",
                mimeType = resolvedMime,
                fileSizeBytes = fileBytes.size.toLong(),
                storageUrl = if (isVideo) KinTaleMediaConfig.deliveryUrl(publicId, true, format) else secureUrl,
                thumbnailUrl = KinTaleMediaConfig.thumbnailUrl(publicId, isVideo),
                uploadedAt = Instant.now().toString(),
                // Real signed-in uploader (was hardcoded "auntie"); single-admin fallback.
                uploadedBy = jvmFirebaseUid()?.takeIf { it.isNotBlank() } ?: "auntie",
                cloudinaryPublicId = publicId,
            )
            // Stage 0I: a test admin must stamp kinfolkId == testTribeId or the rules deny the write.
            val scoped = record.withSandboxScope(platformTestTribeId(forceRefresh = false))
            val id = JvmFirestoreRest.addDoc("media_files", codec.encodeToString(scoped))
            WriteResult.Ok(scoped.copy(_id = id))
        } catch (e: Exception) {
            WriteResult.Err(e.message ?: "upload failed")
        }
    }

    /**
     * #583. Cloudinary's own resource vocabulary for a picked file, sent to the
     * signer so it knows whether to sign the metadata-strip transformation.
     * IMAGE is the only kind that strips: `fl_force_strip` is an image flag, and
     * an incoming transformation on a video would mean re-encoding the whole
     * file inside the upload request.
     *
     * Internal rather than private so the upload contract is testable without a
     * picker, a signed-in admin, or a network call.
     */
    internal fun cloudinaryResourceKind(mimeType: String): String {
        val mime = mimeType.trim().lowercase()
        return when {
            mime.startsWith("image/") -> "image"
            mime.startsWith("video/") -> "video"
            else -> "raw"
        }
    }
    private suspend fun fetchSignedUpload(
        token: String,
        folder: String,
        entityType: String,
        entityId: String,
        resourceKind: String,
    ): CloudinarySignedUpload {
        val resp = http.post(SIGN_URL) {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject {
                put("folder", folder)
                put("entityType", entityType)
                put("entityId", entityId)
                put("resourceKind", resourceKind)
            }.toString())
        }
        val text = resp.bodyAsText()
        if (!resp.status.isSuccess()) error("Cloudinary signing failed (${resp.status.value}): ${text.take(180)}")
        val o: JsonObject = codec.parseToJsonElement(text).jsonObject
        val signed = CloudinarySignedUpload(
            cloudName = o["cloudName"]?.jsonPrimitive?.content.orEmpty(),
            apiKey = o["apiKey"]?.jsonPrimitive?.content.orEmpty(),
            timestamp = o["timestamp"]?.jsonPrimitive?.longOrNull ?: 0L,
            signature = o["signature"]?.jsonPrimitive?.content.orEmpty(),
            folder = o["folder"]?.jsonPrimitive?.content.orEmpty().ifBlank { folder },
            // Absent on a signer that predates #583: blank means "sign nothing
            // extra, post nothing extra", i.e. the old request verbatim.
            transformation = o["transformation"]?.jsonPrimitive?.content.orEmpty(),
            entityType = entityType,
            entityId = entityId,
        )
        require(signed.cloudName.isNotBlank() && signed.apiKey.isNotBlank() && signed.signature.isNotBlank()) {
            "Cloudinary signing response missing required fields"
        }
        return signed
    }

    /** Swing file picker, run on the EDT. Returns null if the user cancels. */
    private suspend fun pickImageFile(): File? = withContext(Dispatchers.IO) {
        var chosen: File? = null
        val task = Runnable {
            val chooser = JFileChooser().apply {
                dialogTitle = "Choose a photo"
                isAcceptAllFileFilterUsed = false
                fileFilter = FileNameExtensionFilter("Images", *IMAGE_EXTENSIONS)
            }
            if (chooser.showOpenDialog(null) == JFileChooser.APPROVE_OPTION) {
                chosen = chooser.selectedFile
            }
        }
        if (SwingUtilities.isEventDispatchThread()) task.run() else SwingUtilities.invokeAndWait(task)
        chosen
    }

    private fun guessMime(file: File): String = when (file.extension.lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "bmp" -> "image/bmp"
        "heic" -> "image/heic"
        else -> "application/octet-stream"
    }
}
