package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

private val mediaEnvelopeJson = Json { ignoreUnknownKeys = true; isLenient = true }

/**
 * Run-4 #4b: pure decode of the picker -> Cloudinary upload envelope
 *   { ok, files:[{ publicId, secureUrl, resourceType, format, width, height,
 *                  durationSeconds, originalFileName, fileSizeBytes, mimeType }] }
 * into one [MediaFile] PER file. The old single path took only `files.first()`, so
 * selecting multiple images saved just one (the #4 bug). Records come back UNSAVED
 * (no `_id`, no sandbox scope); the platform interop layer stamps the sandbox scope
 * and writes each to `media_files`. `kinfolkId` is stamped when the entity itself is
 * a household so the gallery can scope kin-tagging. Fail-loud: ok=false surfaces the
 * server's error verbatim via [WriteResult.Err]; a malformed envelope is an error,
 * never a silent empty success.
 */
internal fun decodeUploadedMedia(
    envelopeJson: String,
    entityId: String,
    entityType: String,
    nowIso: String,
    uploadedBy: String,
    tags: List<String> = emptyList(),
): WriteResult<List<MediaFile>> {
    val envelope = runCatching { mediaEnvelopeJson.parseToJsonElement(envelopeJson) as JsonObject }
        .getOrElse { return WriteResult.Err("invalid upload response") }
    val ok = envelope["ok"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() == true
    if (!ok) return WriteResult.Err(envelope["error"]?.jsonPrimitive?.contentOrNull ?: "upload failed")

    val kinfolkId = if (entityType.equals("kinfolk", ignoreCase = true)) entityId else ""
    val records = (envelope["files"] as? JsonArray).orEmpty().mapNotNull { item ->
        val obj = item as? JsonObject ?: return@mapNotNull null
        val publicId  = obj["publicId"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val secureUrl = obj["secureUrl"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val resType   = obj["resourceType"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val format    = obj["format"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val original  = obj["originalFileName"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val isVideo   = resType.equals("video", ignoreCase = true)
        MediaFile(
            entityId         = entityId,
            entityType       = entityType,
            kinfolkId        = kinfolkId,
            fileName         = publicId.substringAfterLast('/').ifBlank { original },
            originalFileName = original,
            fileType         = if (isVideo) "VIDEO" else "IMAGE",
            mimeType         = obj["mimeType"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            fileSizeBytes    = obj["fileSizeBytes"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L,
            storageUrl       = if (isVideo) KinTaleMediaConfig.deliveryUrl(publicId, true, format) else secureUrl,
            thumbnailUrl     = KinTaleMediaConfig.thumbnailUrl(publicId, isVideo),
            uploadedAt       = nowIso,
            uploadedBy       = uploadedBy,
            tags             = tags,
            durationSeconds  = obj["durationSeconds"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()?.toInt() ?: 0,
            width            = obj["width"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0,
            height           = obj["height"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0,
            cloudinaryPublicId = publicId,
        )
    }
    return WriteResult.Ok(records)
}
