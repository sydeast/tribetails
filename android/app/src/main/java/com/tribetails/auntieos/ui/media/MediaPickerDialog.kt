package com.tribetails.auntieos.ui.media

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
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
    val permissionsGranted: Boolean = false,
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
    var showPermissionDialog by remember { mutableStateOf(false) }
    var cameraImageUri by remember { mutableStateOf<Uri?>(null) }

    // Check permissions on first composition
    LaunchedEffect(Unit) {
        state = state.copy(
            permissionsGranted = hasMediaPermissions(context)
        )
    }

    // Permission launcher
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val allGranted = permissions.values.all { it }
        state = state.copy(permissionsGranted = allGranted)
        if (!allGranted) {
            state = state.copy(error = "Camera and storage permissions are required for media upload")
        }
    }

    // Gallery picker launcher
    val galleryLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris ->
        if (uris.isNotEmpty()) {
            state = state.copy(selectedUris = state.selectedUris + uris)
        }
    }

    // Camera launcher
    val cameraLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { success ->
        if (success && cameraImageUri != null) {
            state = state.copy(selectedUris = state.selectedUris + cameraImageUri!!)
        }
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
                enabled = state.selectedUris.isNotEmpty() && !state.isUploading && state.permissionsGranted,
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
            if (!state.permissionsGranted) {
                PermissionRequestCard(
                    onRequestPermissions = {
                        permissionLauncher.launch(
                            arrayOf(
                                Manifest.permission.CAMERA,
                                Manifest.permission.READ_EXTERNAL_STORAGE,
                                Manifest.permission.READ_MEDIA_IMAGES,
                                Manifest.permission.READ_MEDIA_VIDEO
                            )
                        )
                    }
                )
            } else {
                MediaPickerContent(
                    state = state,
                    onTakePhoto = {
                        cameraImageUri = createImageUri(context)
                        cameraImageUri?.let { uri ->
                            cameraLauncher.launch(uri)
                        }
                    },
                    onPickFromGallery = {
                        galleryLauncher.launch("image/*,video/*")
                    },
                    onRemoveMedia = { uri ->
                        state = state.copy(
                            selectedUris = state.selectedUris.filter { it != uri }
                        )
                    }
                )
            }

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
private fun PermissionRequestCard(
    onRequestPermissions: () -> Unit
) {
    AuntieCard(
        containerColor = AuntieTheme.colors.surface2,
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Icon(
                Lucide.Camera,
                contentDescription = null,
                modifier = Modifier.size(48.dp),
                tint = AuntieTheme.colors.kinfolkOrange
            )
            Spacer(Modifier.height(12.dp))
            Text(
                "Camera & Storage Access",
                style = AuntieTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "Allow access to camera and storage to upload photos and videos.",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim
            )
            Spacer(Modifier.height(16.dp))
            PrimaryButton(
                label = "Grant Permissions",
                onClick = onRequestPermissions
            )
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

private fun hasMediaPermissions(context: Context): Boolean {
    return ContextCompat.checkSelfPermission(
        context, Manifest.permission.CAMERA
    ) == PackageManager.PERMISSION_GRANTED &&
    ContextCompat.checkSelfPermission(
        context, Manifest.permission.READ_EXTERNAL_STORAGE
    ) == PackageManager.PERMISSION_GRANTED
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
