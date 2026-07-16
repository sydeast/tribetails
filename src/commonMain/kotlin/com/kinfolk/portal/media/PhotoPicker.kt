package com.kinfolk.portal.media

import androidx.compose.runtime.Composable

/**
 * Cross-platform photo selection. Implementation per target:
 * - android: PickVisualMedia (Activity Result API), surfaced via a Composable hook
 *            because the launcher must be registered inside a Composable scope.
 * - js:      hidden `input[type=file][accept=image]` triggered programmatically.
 * - jvm:     no-op stub returning null with a warning log.
 */
data class PickedImage(
    val bytes: ByteArray,
    /** MIME type, e.g. "image/jpeg" / "image/png". */
    val mimeType: String,
    /** Display file name. May be empty on platforms that don't expose it. */
    val fileName: String,
)

/**
 * Returns a `() -> Unit` lambda that, when invoked, presents the platform
 * image picker. The provided [onPicked] callback fires with the chosen image
 * (or null if the user cancelled). Must be invoked from a Composable scope.
 */
@Composable
expect fun rememberPhotoPicker(onPicked: (PickedImage?) -> Unit): () -> Unit
