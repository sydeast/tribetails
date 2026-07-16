package com.kinfolk.portal.media

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import kotlinx.browser.document
import org.khronos.webgl.ArrayBuffer
import org.khronos.webgl.Int8Array
import org.w3c.dom.HTMLInputElement
import org.w3c.dom.events.Event
import org.w3c.files.FileReader

@Composable
actual fun rememberPhotoPicker(onPicked: (PickedImage?) -> Unit): () -> Unit {
    return remember(onPicked) {
        {
            // Create a transient hidden file input, click it, attach a one-shot
            // change handler. Removed from DOM after the user closes the picker.
            val input = document.createElement("input") as HTMLInputElement
            input.type = "file"
            input.accept = "image/*"
            input.style.display = "none"
            document.body?.appendChild(input)

            input.addEventListener("change", { _: Event ->
                val file = input.files?.item(0)
                document.body?.removeChild(input)
                if (file == null) {
                    onPicked(null)
                    return@addEventListener
                }
                val reader = FileReader()
                reader.onload = { _: Event ->
                    val buffer = reader.result as? ArrayBuffer
                    if (buffer == null) {
                        onPicked(null)
                    } else {
                        val view = Int8Array(buffer)
                        val d = view.asDynamic()
                        val bytes = ByteArray(view.length) { i -> (d[i] as Number).toByte() }
                        onPicked(
                            PickedImage(
                                bytes = bytes,
                                mimeType = file.type.ifBlank { "image/jpeg" },
                                fileName = file.name,
                            )
                        )
                    }
                    Unit
                }
                reader.onerror = { _: Event -> onPicked(null); Unit }
                reader.readAsArrayBuffer(file)
            })

            // Cancel handler — fires when the user closes without selecting.
            // Browsers don't reliably emit this event, so the listener is best-effort.
            input.addEventListener("cancel", { _: Event ->
                document.body?.removeChild(input)
                onPicked(null)
            })

            input.click()
            Unit
        }
    }
}
