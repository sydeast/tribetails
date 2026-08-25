package com.kinfolk.portal.media

import kotlinx.coroutines.await
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.khronos.webgl.ArrayBuffer
import org.khronos.webgl.Int8Array
import org.w3c.fetch.RequestInit
import org.w3c.files.Blob
import org.w3c.files.BlobPropertyBag
import org.w3c.xhr.FormData

/**
 * JS: builds a `FormData` and posts via fetch. Browser sets the multipart
 * boundary automatically. No deps beyond browser APIs.
 */
actual suspend fun uploadImageToCloudinary(
    signed: CloudinarySignedUpload,
    image: PickedImage,
): String? {
    val view = Int8Array(image.bytes.size)
    val d = view.asDynamic()
    for (i in image.bytes.indices) d[i] = image.bytes[i]
    val blob = Blob(
        arrayOf(view.asDynamic().buffer.unsafeCast<ArrayBuffer>()),
        BlobPropertyBag(type = image.mimeType.ifBlank { "image/jpeg" }),
    )

    val form = FormData()
    form.append("api_key",   signed.apiKey)
    form.append("timestamp", signed.timestamp.toString())
    form.append("signature", signed.signature)
    form.append("folder",    signed.folder)
    // Must exactly echo what the server signed, or Cloudinary rejects the
    // upload as a signature mismatch.
    if (signed.allowedFormats.isNotBlank()) form.append("allowed_formats", signed.allowedFormats)
    if (signed.transformation.isNotBlank()) form.append("transformation", signed.transformation)
    form.append("file",      blob, image.fileName.ifBlank { "photo" })

    val resp = kotlinx.browser.window.fetch(
        "https://api.cloudinary.com/v1_1/${signed.cloudName}/image/upload",
        RequestInit(method = "POST", body = form),
    ).await()

    if (!resp.ok) {
        console.error("Cloudinary upload failed", resp.status, resp.statusText)
        return null
    }
    val text = resp.text().await()
    return runCatching {
        val obj = Json.parseToJsonElement(text).jsonObject
        obj["secure_url"]?.jsonPrimitive?.contentOrNull
    }.getOrNull()
}
