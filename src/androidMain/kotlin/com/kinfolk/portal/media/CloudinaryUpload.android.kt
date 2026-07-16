package com.kinfolk.portal.media

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.DataOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * Android: HttpURLConnection-based multipart POST. No new deps required —
 * gitlive already pulls in OkHttp transitively but this stays platform-vanilla
 * so the upload path doesn't bind to gitlive internals.
 */
actual suspend fun uploadImageToCloudinary(
    signed: CloudinarySignedUpload,
    image: PickedImage,
): String? = withContext(Dispatchers.IO) {
    val boundary = "----AuntieKinfolk${UUID.randomUUID()}"
    val url = URL("https://api.cloudinary.com/v1_1/${signed.cloudName}/image/upload")
    val conn = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        doOutput = true
        useCaches = false
        connectTimeout = 30_000
        readTimeout = 60_000
        setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
    }

    runCatching {
        DataOutputStream(conn.outputStream).use { out ->
            fun writeField(name: String, value: String) {
                out.writeBytes("--$boundary\r\n")
                out.writeBytes("Content-Disposition: form-data; name=\"$name\"\r\n\r\n")
                out.writeBytes(value)
                out.writeBytes("\r\n")
            }
            writeField("api_key",   signed.apiKey)
            writeField("timestamp", signed.timestamp.toString())
            writeField("signature", signed.signature)
            writeField("folder",    signed.folder)
            // Must exactly echo what the server signed, or Cloudinary
            // rejects the upload as a signature mismatch.
            if (signed.allowedFormats.isNotBlank()) writeField("allowed_formats", signed.allowedFormats)

            out.writeBytes("--$boundary\r\n")
            out.writeBytes(
                "Content-Disposition: form-data; name=\"file\"; filename=\"${image.fileName.ifBlank { "photo" }}\"\r\n"
            )
            out.writeBytes("Content-Type: ${image.mimeType.ifBlank { "image/jpeg" }}\r\n\r\n")
            out.write(image.bytes)
            out.writeBytes("\r\n")
            out.writeBytes("--$boundary--\r\n")
            out.flush()
        }

        val code = conn.responseCode
        val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
            .bufferedReader().use { it.readText() }
        if (code !in 200..299) {
            android.util.Log.e("CloudinaryUpload", "Upload failed ($code): $body")
            return@runCatching null
        }
        JSONObject(body).optString("secure_url").takeIf { it.isNotBlank() }
    }.getOrElse {
        android.util.Log.e("CloudinaryUpload", "Upload failed", it)
        null
    }.also { conn.disconnect() }
}
