package com.tribetails.auntieos.ui.media

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.crossfade
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

data class MediaPickerState(
    val selectedUris: List<Uri> = emptyList(),
    val isUploading: Boolean = false,
    val uploadProgress: Float = 0f,
    val error: String? = null
)

@Composable
fun MediaPickerDialog(
    entityId: String,
    entityType: MediaEntityType,
    entityName: String,
    onDismiss: () -> Unit,
    onMediaUploaded: (List<String>) -> Unit,
    viewModel: MediaUploadViewModel
) {
    val context = LocalContext.current
    var state by remember { mutableStateOf(MediaPickerState()) }
    var cameraImageUri by remember { mutableStateOf<Uri?>(null) }

    // Gallery via the Android Photo Picker - permission-free, same pattern as the
    // Profile avatar path. Images + videos, multi-select. No storage permission,
    // no up-front gate: the first-upload experience just works. (I3)
    val galleryLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia()
    ) { uris ->
        if (uris.isNotEmpty()) {
            state = state.copy(selectedUris = state.selectedUris + uris)
        }
    }

    // Camera capture launcher (writes into a FileProvider uri).
    val cameraLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { success ->
        if (success && cameraImageUri != null) {
            state = state.copy(selectedUris = state.selectedUris + cameraImageUri!!)
        }
    }

    fun launchCameraCapture() {
        val uri = createImageUri(context)
        cameraImageUri = uri
        cameraLauncher.launch(uri)
    }

    // CAMERA is requested ONLY when the user chooses "Camera" - the gallery path
    // needs no runtime permission at all.
    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) launchCameraCapture()
        else state = state.copy(error = "Camera permission is needed to take a photo.")
    }

    AuntieModal(
        onDismissRequest = onDismiss,
        title = "Add Media for $entityName",
        confirmButton = {
            PrimaryButton(
                label = "Upload ${state.selectedUris.size} file${if (state.selectedUris.size == 1) "" else "s"}",
                onClick = {
                    if (state.selectedUris.isNotEmpty() && !state.isUploading) {
                        state = state.copy(isUploading = true, error = null)

                        viewModel.uploadMedia(
                            uris = state.selectedUris,
                            entityId = entityId,
                            entityType = entityType,
                            onProgress = { progress ->
                                state = state.copy(uploadProgress = progress)
                            },
                            onComplete = { result ->
                                result.fold(
                                    onSuccess = { batchResult ->
                                        if (batchResult.succeeded.isNotEmpty()) {
                                            onMediaUploaded(batchResult.succeeded.map { it.id })
                                        }
                                        if (batchResult.hasFailures) {
                                            val failMsg = "${batchResult.failed.size} of ${batchResult.totalRequested} upload(s) failed"
                                            state = state.copy(
                                                isUploading = false,
                                                error = failMsg
                                            )
                                        } else {
                                            onDismiss()
                                        }
                                    },
                                    onFailure = { error ->
                                        state = state.copy(
                                            isUploading = false,
                                            error = error.message ?: "Upload failed"
                                        )
                                    }
                                )
                            }
                        )
                    }
                },
                enabled = state.selectedUris.isNotEmpty() && !state.isUploading,
                loading = state.isUploading,
            )
        },
        dismissButton = {
            AuntieTextBtn(
                onClick = onDismiss,
                enabled = !state.isUploading
            ) {
                Text("Cancel")
            }
        }
    ) {
        Column {
            MediaPickerContent(
                state = state,
                onTakePhoto = {
                    if (ContextCompat.checkSelfPermission(
                            context, Manifest.permission.CAMERA
                        ) == PackageManager.PERMISSION_GRANTED
                    ) {
                        launchCameraCapture()
                    } else {
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                    }
                },
                onPickFromGallery = {
                    galleryLauncher.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)
                    )
                },
                onRemoveMedia = { uri ->
                    state = state.copy(
                        selectedUris = state.selectedUris.filter { it != uri }
                    )
                }
            )

            // Error display
            if (state.error != null) {
                Spacer(Modifier.height(8.dp))
                AuntieCard(containerColor = AuntieTheme.colors.errorContainer) {
                    Text(
                        text = state.error!!,
                        modifier = Modifier.padding(12.dp),
                        color = AuntieTheme.colors.error,
                        style = AuntieTheme.typography.bodySmall
                    )
                }
            }

            // Upload progress
            if (state.isUploading) {
                Spacer(Modifier.height(12.dp))
                Column {
                    Text(
                        "Uploading...",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim
                    )
                    Spacer(Modifier.height(4.dp))
                    AuntieLinearProgress(
                        modifier = Modifier.fillMaxWidth(),
                        color = AuntieTheme.colors.kinfolkOrange
                    )
                    Text(
                        "${(state.uploadProgress * 100).toInt()}%",
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.textDim
                    )
                }
            }
        }
    }
}

@Composable
private fun MediaPickerContent(
    state: MediaPickerState,
    onTakePhoto: () -> Unit,
    onPickFromGallery: () -> Unit,
    onRemoveMedia: (Uri) -> Unit
) {
    Column {
        // Action Buttons
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            GhostButton(
                label = "Camera",
                onClick = onTakePhoto,
                modifier = Modifier.weight(1f),
                leading = { Icon(Lucide.Camera, contentDescription = null, modifier = Modifier.size(18.dp)) }
            )

            GhostButton(
                label = "Gallery",
                onClick = onPickFromGallery,
                modifier = Modifier.weight(1f),
                leading = { Icon(Lucide.Images, contentDescription = null, modifier = Modifier.size(18.dp)) }
            )
        }

        // Selected Media Preview
        if (state.selectedUris.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            Text(
                "Selected Media (${state.selectedUris.size})",
                style = AuntieTheme.typography.labelMedium,
                color = AuntieTheme.colors.kinfolkOrange
            )
            Spacer(Modifier.height(8.dp))

            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(state.selectedUris) { uri ->
                    MediaPreviewItem(
                        uri = uri,
                        onRemove = { onRemoveMedia(uri) }
                    )
                }
            }
        } else {
            Spacer(Modifier.height(16.dp))
            Text(
                "No media selected",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim
            )
        }
    }
}

@Composable
private fun MediaPreviewItem(
    uri: Uri,
    onRemove: () -> Unit
) {
    val context = LocalContext.current

    Box(
        modifier = Modifier
            .size(80.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface2)
            .border(0.5.dp, AuntieTheme.colors.border, RoundedCornerShape(8.dp))
    ) {
        AsyncImage(
            model = ImageRequest.Builder(context)
                .data(uri)
                .crossfade(true)
                .build(),
            contentDescription = "Selected media",
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop
        )

        // Remove button
        AuntieIconBtn(
            onClick = onRemove,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .size(24.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(20.dp)
                    .clip(RoundedCornerShape(50))
                    .background(AuntieTheme.colors.background.copy(alpha = 0.8f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Lucide.X,
                    contentDescription = "Remove",
                    tint = AuntieTheme.colors.error,
                    modifier = Modifier.size(12.dp)
                )
            }
        }
    }
}

private fun createImageUri(context: Context): Uri {
    val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
    val imageFileName = "JPEG_${timeStamp}_"
    val storageDir = context.cacheDir
    val imageFile = File.createTempFile(imageFileName, ".jpg", storageDir)

    return FileProvider.getUriForFile(
        context,
        "${context.packageName}.fileprovider",
        imageFile
    )
}
