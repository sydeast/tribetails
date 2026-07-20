package com.kinfolk.portal.media

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import java.awt.FileDialog
import java.awt.Frame
import java.io.File
import kotlin.concurrent.thread

private val IMAGE_EXTENSIONS = mapOf(
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "png" to "image/png",
    "webp" to "image/webp",
    "gif" to "image/gif",
)

/**
 * Desktop picker via java.awt.FileDialog (native OS dialog; nicer than
 * JFileChooser on macOS). FileDialog.setVisible blocks, so it runs on a
 * dedicated thread; [onPicked] fires from that thread — Compose snapshot
 * writes are thread-safe, and callers hop to a coroutine anyway.
 */
@Composable
actual fun rememberPhotoPicker(onPicked: (PickedImage?) -> Unit): () -> Unit {
    return remember(onPicked) {
        {
            thread(name = "kin-photo-picker", isDaemon = true) {
                val picked = runCatching {
                    val dialog = FileDialog(null as Frame?, "Choose a photo", FileDialog.LOAD)
                    dialog.setFilenameFilter { _, fileName ->
                        fileName.substringAfterLast('.', "").lowercase() in IMAGE_EXTENSIONS
                    }
                    dialog.isVisible = true // blocks until the user picks or cancels
                    val fileName = dialog.file ?: return@runCatching null // cancelled
                    val file = File(dialog.directory ?: ".", fileName)
                    val mime = IMAGE_EXTENSIONS[file.extension.lowercase()]
                        ?: "application/octet-stream" // KinPhotoPolicy rejects with a clear message
                    PickedImage(
                        bytes = file.readBytes(),
                        mimeType = mime,
                        fileName = file.name,
                    )
                }.getOrNull()
                onPicked(picked)
            }
            Unit
        }
    }
}
